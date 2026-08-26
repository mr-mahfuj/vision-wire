// protocol.js — the on-the-wire (on-the-screen) frame format.
//
// Every displayed grid encodes exactly one binary frame:
//
//   offset  size  field
//   0       2     magic            0xA5B7
//   2       1     version
//   3       1     type             0=CALIB 1=META 2=DATA 3=REPAIR 4=PARITY 5=END
//   4       4     sessionId        random per transfer, rejects stale frames
//   8       4     frameId          block index (DATA) / symbol id (REPAIR/PARITY) / 0
//   12      4     totalUnits       K = number of source blocks
//   16      2     payloadLen
//   18      N     payload
//   18+N    4     crc32 over bytes [0, 18+N)
//
// Header + CRC overhead is 22 bytes/frame — far less than a QR code's finder
// patterns + format/version info + baked-in Reed-Solomon overhead, which is
// why a custom grid carries meaningfully more payload per cell.

import { crc32 } from "./utils.js";

export const MAGIC = 0xa5b7;
export const VERSION = 1;
export const HEADER_LEN = 18;
export const CRC_LEN = 4;
export const OVERHEAD = HEADER_LEN + CRC_LEN; // 22

export const FrameType = Object.freeze({
  CALIB: 0,
  META: 1,
  DATA: 2,
  REPAIR: 3,
  PARITY: 4,
  END: 5,
});

export const FecMode = Object.freeze({
  NONE: 0,
  XOR: 1,
  FOUNTAIN: 2,
});

/**
 * Build a wire frame.
 * @param {{type:number, sessionId:number, frameId:number, totalUnits:number, payload:Uint8Array}} f
 * @returns {Uint8Array}
 */
export function buildFrame({ type, sessionId, frameId, totalUnits, payload }) {
  const out = new Uint8Array(HEADER_LEN + payload.length + CRC_LEN);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, MAGIC);
  dv.setUint8(2, VERSION);
  dv.setUint8(3, type);
  dv.setUint32(4, sessionId >>> 0);
  dv.setUint32(8, frameId >>> 0);
  dv.setUint32(12, totalUnits >>> 0);
  dv.setUint16(16, payload.length);
  out.set(payload, HEADER_LEN);
  const crc = crc32(out, 0, HEADER_LEN + payload.length);
  dv.setUint32(HEADER_LEN + payload.length, crc);
  return out;
}

/**
 * Parse+validate a wire frame recovered from a decoded grid.
 * @param {Uint8Array} bytes
 * @returns {{ok:true,type:number,sessionId:number,frameId:number,totalUnits:number,payload:Uint8Array}|{ok:false,reason:string}}
 */
export function parseFrame(bytes) {
  if (bytes.length < HEADER_LEN + CRC_LEN) return { ok: false, reason: "short" };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint16(0) !== MAGIC) return { ok: false, reason: "magic" };
  const version = dv.getUint8(2);
  if (version !== VERSION) return { ok: false, reason: "version" };
  const type = dv.getUint8(3);
  const sessionId = dv.getUint32(4) >>> 0;
  const frameId = dv.getUint32(8) >>> 0;
  const totalUnits = dv.getUint32(12) >>> 0;
  const payloadLen = dv.getUint16(16);
  const end = HEADER_LEN + payloadLen;
  if (bytes.length < end + CRC_LEN) return { ok: false, reason: "truncated" };
  const expectedCrc = dv.getUint32(end);
  const actualCrc = crc32(bytes, 0, end);
  if (expectedCrc !== actualCrc) return { ok: false, reason: "crc" };
  return {
    ok: true,
    type,
    sessionId,
    frameId,
    totalUnits,
    payload: bytes.subarray(HEADER_LEN, end),
  };
}

/** Total bits a frame of `payloadBytes` needs on the grid. */
export function frameBits(payloadBytes) {
  return (OVERHEAD + payloadBytes) * 8;
}

// ---------------------------------------------------------------------------
// META payload — describes the whole transfer so the receiver can allocate
// buffers and pick the matching FEC decoder before any DATA frame arrives.
// ---------------------------------------------------------------------------
/**
 * @param {object} m
 * @param {string} m.fileName
 * @param {number} m.fileSize        original (pre-compression) byte length
 * @param {number} m.transferSize    bytes actually being sent (post compression)
 * @param {boolean} m.compressed
 * @param {number} m.blockSize
 * @param {number} m.totalBlocks     K
 * @param {number} m.fecMode
 * @param {number} m.fecParam
 * @param {number} m.gridSize
 * @param {number} m.levels          luminance levels per data cell (2 or 4) — see grid.js
 * @param {number} m.fileCrc32       crc32 of the transferSize bytes
 */
export function buildMetaPayload(m) {
  const nameBytes = new TextEncoder().encode(m.fileName.slice(0, 255));
  const out = new Uint8Array(1 + nameBytes.length + 8 + 8 + 1 + 2 + 4 + 1 + 1 + 1 + 1 + 4);
  const dv = new DataView(out.buffer);
  let o = 0;
  out[o] = nameBytes.length;
  o += 1;
  out.set(nameBytes, o);
  o += nameBytes.length;
  // fileSize / transferSize as 64-bit via BigInt (safe up to 2^53 in practice)
  dv.setBigUint64(o, BigInt(m.fileSize));
  o += 8;
  dv.setBigUint64(o, BigInt(m.transferSize));
  o += 8;
  out[o] = m.compressed ? 1 : 0;
  o += 1;
  dv.setUint16(o, m.blockSize);
  o += 2;
  dv.setUint32(o, m.totalBlocks);
  o += 4;
  out[o] = m.fecMode;
  o += 1;
  out[o] = m.fecParam;
  o += 1;
  out[o] = m.gridSize;
  o += 1;
  out[o] = m.levels ?? 2;
  o += 1;
  dv.setUint32(o, m.fileCrc32);
  o += 4;
  return out;
}

export function parseMetaPayload(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const nameLen = bytes[o];
  o += 1;
  const fileName = new TextDecoder().decode(bytes.subarray(o, o + nameLen));
  o += nameLen;
  const fileSize = Number(dv.getBigUint64(o));
  o += 8;
  const transferSize = Number(dv.getBigUint64(o));
  o += 8;
  const compressed = bytes[o] === 1;
  o += 1;
  const blockSize = dv.getUint16(o);
  o += 2;
  const totalBlocks = dv.getUint32(o);
  o += 4;
  const fecMode = bytes[o];
  o += 1;
  const fecParam = bytes[o];
  o += 1;
  const gridSize = bytes[o];
  o += 1;
  const levels = bytes[o];
  o += 1;
  const fileCrc32 = dv.getUint32(o);
  o += 4;
  return {
    fileName,
    fileSize,
    transferSize,
    compressed,
    blockSize,
    totalBlocks,
    fecMode,
    fecParam,
    gridSize,
    levels,
    fileCrc32,
  };
}
