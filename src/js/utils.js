// utils.js — shared, dependency-free helpers used by both sender and receiver.
// Pure logic only (no DOM / camera / canvas access) so it can run in a Worker
// or in Node for testing.

// ---------------------------------------------------------------------------
// CRC32 (used to validate every frame header+payload, and the whole file)
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC32 of a Uint8Array (or subarray). Returns an unsigned 32-bit int. */
export function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Fast, seedable PRNGs. Both sender and receiver derive the *same* stream of
// pseudo-random numbers from a symbol id, so the receiver can recompute which
// source blocks a fountain-repair symbol XORs together without the sender
// ever having to transmit an index list. That's most of where the "custom
// grid + fountain code" design beats a naive QR-per-chunk transfer.
// ---------------------------------------------------------------------------
export function splitmix32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return (t >>> 0) / 4294967296;
  };
}

/** Combine two 32-bit ids into one seed (order matters: session, then id). */
export function seedFrom(a, b) {
  let h = (a >>> 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (b >>> 0), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Bit packing — pack an array of bytes into a 0/1-per-cell bit matrix and
// back. MSB-first within each byte.
// ---------------------------------------------------------------------------
/** bytes -> Uint8Array of 0/1, length = bytes.length * 8 */
export function bytesToBits(bytes) {
  const bits = new Uint8Array(bytes.length * 8);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    const o = i * 8;
    bits[o] = (b >> 7) & 1;
    bits[o + 1] = (b >> 6) & 1;
    bits[o + 2] = (b >> 5) & 1;
    bits[o + 3] = (b >> 4) & 1;
    bits[o + 4] = (b >> 3) & 1;
    bits[o + 5] = (b >> 2) & 1;
    bits[o + 6] = (b >> 1) & 1;
    bits[o + 7] = b & 1;
  }
  return bits;
}

/** bits (0/1 array, length multiple of 8) -> bytes */
export function bitsToBytes(bits) {
  const bytes = new Uint8Array(bits.length >> 3);
  for (let i = 0; i < bytes.length; i++) {
    const o = i * 8;
    bytes[i] =
      (bits[o] << 7) |
      (bits[o + 1] << 6) |
      (bits[o + 2] << 5) |
      (bits[o + 3] << 4) |
      (bits[o + 4] << 3) |
      (bits[o + 5] << 2) |
      (bits[o + 6] << 1) |
      bits[o + 7];
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// XOR helpers for FEC (in place where possible to avoid allocations on hot
// paths — this runs once per received frame).
// ---------------------------------------------------------------------------
export function xorInto(dst, src) {
  for (let i = 0; i < dst.length; i++) dst[i] ^= src[i];
  return dst;
}

export function xorBlocks(blocks) {
  const out = new Uint8Array(blocks[0].length);
  for (const b of blocks) xorInto(out, b);
  return out;
}

// ---------------------------------------------------------------------------
// Small pub/sub used across camera/renderer/decoder/UI glue.
// ---------------------------------------------------------------------------
export class EventEmitter {
  constructor() {
    this._listeners = new Map();
  }
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }
  off(event, fn) {
    this._listeners.get(event)?.delete(fn);
  }
  emit(event, payload) {
    this._listeners.get(event)?.forEach((fn) => fn(payload));
  }
}

// ---------------------------------------------------------------------------
// Misc formatting / helpers
// ---------------------------------------------------------------------------
export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let u = -1;
  do {
    n /= 1024;
    u++;
  } while (n >= 1024 && u < units.length - 1);
  return `${n.toFixed(n >= 10 ? 0 : 1)} ${units[u]}`;
}

export function formatRate(bytesPerSec) {
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatDuration(seconds) {
  if (!isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function utf8Encode(str) {
  return new TextEncoder().encode(str);
}

export function utf8Decode(bytes) {
  return new TextDecoder().decode(bytes);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
