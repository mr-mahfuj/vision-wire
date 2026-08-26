// encoder.js — turns a File into an endless, loss-tolerant stream of grid
// frames ready for renderer.js to display.

import { crc32 } from "./utils.js";
import {
  buildFrame,
  buildMetaPayload,
  FrameType,
  FecMode,
} from "./protocol.js";
import { maxPayloadBytes, pickGridSize, encodeGridCells } from "./grid.js";
import { FountainCoder } from "./fec.js";

/** Try to gzip; fall back to raw bytes if CompressionStream isn't available. */
async function maybeCompress(bytes, enabled) {
  if (!enabled || typeof CompressionStream === "undefined") {
    return { bytes, compressed: false };
  }
  try {
    const cs = new CompressionStream("gzip");
    const stream = new Blob([bytes]).stream().pipeThrough(cs);
    const compressedBuf = await new Response(stream).arrayBuffer();
    const compressed = new Uint8Array(compressedBuf);
    // Only keep it if it actually helped (small/incompressible files can grow).
    if (compressed.length < bytes.length) return { bytes: compressed, compressed: true };
    return { bytes, compressed: false };
  } catch {
    return { bytes, compressed: false };
  }
}

/**
 * @param {File} file
 * @param {object} opts
 * @param {number} [opts.gridSize] explicit grid size, or "auto"
 * @param {string} opts.fecMode 'none' | 'xor' | 'fountain'
 * @param {number} [opts.fecParam] xor group size, or fountain repair-per-K ratio (%)
 * @param {boolean} [opts.compress]
 * @returns {Promise<Transfer>}
 */
export async function prepareTransfer(file, opts) {
  const raw = new Uint8Array(await file.arrayBuffer());
  const { bytes, compressed } = await maybeCompress(raw, opts.compress ?? true);
  const fileCrc32 = crc32(bytes);

  const fecModeCode = { none: FecMode.NONE, xor: FecMode.XOR, fountain: FecMode.FOUNTAIN }[opts.fecMode] ?? FecMode.NONE;
  const fecParam = opts.fecParam ?? (opts.fecMode === "xor" ? 8 : opts.fecMode === "fountain" ? 30 : 0);

  const gridSize = opts.gridSize === "auto" || !opts.gridSize
    ? pickGridSize(estimateIdealPayload(bytes.length))
    : opts.gridSize;
  const blockSize = maxPayloadBytes(gridSize);
  if (blockSize <= 0) throw new Error("Grid size too small to carry protocol overhead.");

  const K = Math.ceil(bytes.length / blockSize) || 1;
  const sessionId = (Math.random() * 0xffffffff) >>> 0;

  const sourceBlocks = new Array(K);
  for (let i = 0; i < K; i++) {
    const block = new Uint8Array(blockSize);
    block.set(bytes.subarray(i * blockSize, (i + 1) * blockSize));
    sourceBlocks[i] = block;
  }

  const metaPayload = buildMetaPayload({
    fileName: file.name || "download.bin",
    fileSize: raw.length,
    transferSize: bytes.length,
    compressed,
    blockSize,
    totalBlocks: K,
    fecMode: fecModeCode,
    fecParam,
    gridSize,
    fileCrc32,
  });

  const fountain = fecModeCode === FecMode.FOUNTAIN ? new FountainCoder(K, sessionId) : null;

  return new Transfer({
    sessionId,
    gridSize,
    K,
    blockSize,
    sourceBlocks,
    metaPayload,
    fecModeCode,
    fecParam,
    fountain,
    fileName: file.name,
    fileSize: raw.length,
    transferSize: bytes.length,
  });
}

function estimateIdealPayload(transferByteLength) {
  // Bigger files benefit from a bigger grid (fewer total frames to loop
  // through) provided the camera can resolve it; smaller files stay on a
  // smaller, more forgiving grid. This just feeds pickGridSize a target
  // payload-per-frame size — pickGridSize does the actual candidate lookup.
  if (transferByteLength > 20 * 1024 * 1024) return 1600; // -> 128 grid
  if (transferByteLength > 4 * 1024 * 1024) return 900; // -> 96 grid
  if (transferByteLength > 300 * 1024) return 380; // -> 64 grid
  return 200; // -> 48 grid for small files: easier lock, fewer cells to hold steady
}

/**
 * Generates an endless sequence of {gridSize, cells} ready to hand straight
 * to renderer.js. Repeats forever (looping) so a receiver that starts late,
 * or misses a burst of frames, will always eventually see every symbol it
 * needs.
 */
export class Transfer {
  constructor(cfg) {
    Object.assign(this, cfg);
    this._xorGroups = this.fecModeCode === FecMode.XOR ? Math.ceil(this.K / Math.max(1, this.fecParam)) : 0;
    this._repairPerPass = this.fecModeCode === FecMode.FOUNTAIN
      ? Math.max(1, Math.ceil((this.K * this.fecParam) / 100))
      : 0;
    this._nextRepairId = 0;
  }

  totalBytes() {
    return this.transferSize;
  }

  /** One full logical loop's frame count (for progress / ETA estimates). */
  framesPerLoop() {
    const calib = 8;
    const meta = 6;
    let repair = 0;
    if (this.fecModeCode === FecMode.XOR) repair = this._xorGroups;
    if (this.fecModeCode === FecMode.FOUNTAIN) repair = this._repairPerPass;
    return calib + meta + this.K + repair;
  }

  _xorParityFrame(groupIdx) {
    const start = groupIdx * this.fecParam;
    const end = Math.min(this.K, start + this.fecParam);
    const parity = new Uint8Array(this.blockSize);
    for (let i = start; i < end; i++) {
      const b = this.sourceBlocks[i];
      for (let j = 0; j < b.length; j++) parity[j] ^= b[j];
    }
    return buildFrame({
      type: FrameType.PARITY,
      sessionId: this.sessionId,
      frameId: groupIdx,
      totalUnits: this.K,
      payload: parity,
    });
  }

  _repairFrame() {
    const id = this._nextRepairId++;
    const payload = this.fountain.encodeSymbol(id, this.sourceBlocks);
    return buildFrame({
      type: FrameType.REPAIR,
      sessionId: this.sessionId,
      frameId: id,
      totalUnits: this.K,
      payload,
    });
  }

  /**
   * Async generator yielding {gridSize, cells, kind, index, loop} forever
   * until `signal.aborted`. renderer.js drives this at the configured FPS.
   */
  async *frames(signal) {
    let loop = 0;
    while (!signal?.aborted) {
      // Calibration burst so a fresh receiver locks on quickly.
      for (let i = 0; i < 8 && !signal?.aborted; i++) {
        yield this._grid(this._calibFrame(), "calib", loop);
      }
      // Meta repeated so a receiver that missed the first burst still gets it.
      for (let i = 0; i < 6 && !signal?.aborted; i++) {
        const f = buildFrame({
          type: FrameType.META,
          sessionId: this.sessionId,
          frameId: 0,
          totalUnits: this.K,
          payload: this.metaPayload,
        });
        yield this._grid(f, "meta", loop);
      }
      for (let i = 0; i < this.K && !signal?.aborted; i++) {
        const f = buildFrame({
          type: FrameType.DATA,
          sessionId: this.sessionId,
          frameId: i,
          totalUnits: this.K,
          payload: this.sourceBlocks[i],
        });
        yield this._grid(f, "data", loop, i);
      }
      if (this.fecModeCode === FecMode.XOR) {
        for (let g = 0; g < this._xorGroups && !signal?.aborted; g++) {
          yield this._grid(this._xorParityFrame(g), "parity", loop, g);
        }
      } else if (this.fecModeCode === FecMode.FOUNTAIN) {
        for (let i = 0; i < this._repairPerPass && !signal?.aborted; i++) {
          yield this._grid(this._repairFrame(), "repair", loop, i);
        }
      }
      loop++;
    }
  }

  _calibFrame() {
    return buildFrame({
      type: FrameType.CALIB,
      sessionId: this.sessionId,
      frameId: 0,
      totalUnits: this.K,
      payload: new Uint8Array(0),
    });
  }

  _grid(wireBytes, kind, loop, index = 0) {
    return { gridSize: this.gridSize, cells: encodeGridCells(this.gridSize, wireBytes), kind, loop, index };
  }
}
