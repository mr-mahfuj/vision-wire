// grid.js — the visual encoding: how a frame's bytes become an N×N grid of
// cells, and how much payload fits per frame at a given grid size. Shared
// by the sender (renderer.js draws it) and the receiver (decoder.js /
// worker.js sample it back).
//
// Layout for an N×N grid:
//   - A 1-cell quiet border (always at the "white"/max level) so the marker
//     blocks don't touch the edge of the display / camera crop.
//   - Four MARKER_SIZE×MARKER_SIZE solid corner blocks: top-left, top-right,
//     and bottom-left are BLACK; bottom-right is WHITE. Three-dark-one-light
//     is enough to fix orientation (the odd corner out is always "bottom
//     right") without needing a 4th distinct pattern. Markers are ALWAYS
//     pure black/white, regardless of the data cells' bit depth — they need
//     maximum, unambiguous contrast for the receiver's per-frame tracking
//     search (worker.js), independent of how dense the payload encoding is.
//   - Every remaining cell carries `bitsPerLevel(levels)` bits of payload,
//     via `levels` evenly-spaced luminance steps rather than plain
//     black/white. This is the same lever color-icon-matrix barcodes like
//     Cimbar use to beat QR-style codes on bandwidth (more bits per
//     tile/cell) — done here with grayscale levels instead of Cimbar's
//     shape+color combination, which needs robust image-hash symbol
//     recognition to decode reliably. Grayscale levels reuse the exact same
//     adaptive per-frame luminance threshold machinery already validated
//     for binary cells, just with more threshold cut-points, which is a
//     meaningfully lower reliability risk for a link that can't be tested
//     against real camera hardware in this environment.
//
// `levels` must be a power of two that evenly divides 8 (2 or 4 — i.e. 1 or
// 2 bits/cell) so payloads stay byte-aligned with no partial-bit-group
// bookkeeping at the end of a frame.

import { OVERHEAD, frameBits } from "./protocol.js";

export const MARKER_SIZE = 4;
export const QUIET = 1;

export function gridCellCount(gridSize) {
  const total = gridSize * gridSize;
  const markerCells = 4 * MARKER_SIZE * MARKER_SIZE;
  const border = 4 * gridSize * QUIET - 4 * QUIET * QUIET; // approx, quiet ring
  return total - markerCells - border;
}

export function bitsPerLevel(levels) {
  // levels must be 2 or 4 for now (see file header) — Math.log2 of either
  // is exact (1 or 2), so no rounding concerns.
  return Math.log2(levels);
}

/** True if cell (x,y) is inside the quiet border or a corner marker block. */
export function isReservedCell(x, y, gridSize) {
  if (x < QUIET || y < QUIET || x >= gridSize - QUIET || y >= gridSize - QUIET) return true;
  const inTL = x < QUIET + MARKER_SIZE && y < QUIET + MARKER_SIZE;
  const inTR = x >= gridSize - QUIET - MARKER_SIZE && y < QUIET + MARKER_SIZE;
  const inBL = x < QUIET + MARKER_SIZE && y >= gridSize - QUIET - MARKER_SIZE;
  const inBR = x >= gridSize - QUIET - MARKER_SIZE && y >= gridSize - QUIET - MARKER_SIZE;
  return inTL || inTR || inBL || inBR;
}

/** True/false (white/black) of a reserved marker cell — always binary. */
export function markerCellValue(x, y, gridSize) {
  const inTL = x < QUIET + MARKER_SIZE && y < QUIET + MARKER_SIZE;
  const inTR = x >= gridSize - QUIET - MARKER_SIZE && y < QUIET + MARKER_SIZE;
  const inBL = x < QUIET + MARKER_SIZE && y >= gridSize - QUIET - MARKER_SIZE;
  const inBR = x >= gridSize - QUIET - MARKER_SIZE && y >= gridSize - QUIET - MARKER_SIZE;
  if (inTL || inTR || inBL) return 0; // black
  if (inBR) return 1; // white
  return 1; // quiet border is white
}

// Precompute the ordered list of data-cell coordinates for a grid size (it's
// the same list every time, so cache it per gridSize).
const _dataCellCache = new Map();
export function dataCellOrder(gridSize) {
  if (_dataCellCache.has(gridSize)) return _dataCellCache.get(gridSize);
  const cells = [];
  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      if (!isReservedCell(x, y, gridSize)) cells.push([x, y]);
    }
  }
  _dataCellCache.set(gridSize, cells);
  return cells;
}

/** Max payload bytes (excluding protocol header/crc) that fit at gridSize,
 * given `levels` luminance steps per data cell (default 2 = binary). */
export function maxPayloadBytes(gridSize, levels = 2) {
  const totalBits = dataCellOrder(gridSize).length * bitsPerLevel(levels);
  return Math.max(0, Math.floor(totalBits / 8) - OVERHEAD);
}

/** Pick the largest grid size (from candidates) whose capacity covers
 * payloadBytes at the given bit depth. */
export function pickGridSize(payloadBytes, levels = 2, candidates = [48, 64, 96, 128]) {
  for (const g of candidates) {
    if (maxPayloadBytes(g, levels) >= payloadBytes) return g;
  }
  return candidates[candidates.length - 1];
}

/** Read `count` bits (MSB-first, global bitstream position `bitOffset`)
 * from a byte array as an unsigned integer. Out-of-range bits read as 0. */
function readBitGroup(bytes, bitOffset, count) {
  let value = 0;
  for (let b = 0; b < count; b++) {
    const bitPos = bitOffset + b;
    const byteIdx = bitPos >> 3;
    const bitInByte = 7 - (bitPos & 7);
    const bit = byteIdx < bytes.length ? (bytes[byteIdx] >> bitInByte) & 1 : 0;
    value = (value << 1) | bit;
  }
  return value;
}

/** Inverse of readBitGroup: OR `value`'s low `count` bits into `bytes` at
 * the given global bit position (MSB-first). */
function writeBitGroup(bytes, bitOffset, count, value) {
  for (let b = 0; b < count; b++) {
    const bit = (value >> (count - 1 - b)) & 1;
    if (!bit) continue;
    const bitPos = bitOffset + b;
    const byteIdx = bitPos >> 3;
    const bitInByte = 7 - (bitPos & 7);
    bytes[byteIdx] |= 1 << bitInByte;
  }
}

/**
 * Build the full N×N cell matrix (Uint8Array — each entry a level index
 * 0..levels-1, NOT a display luminance byte) for one wire frame's bytes.
 * Unused trailing data cells (padding) are filled at the max level.
 */
export function encodeGridCells(gridSize, frameBytes, levels = 2) {
  const bpl = bitsPerLevel(levels);
  const maxLevel = levels - 1;
  const cells = new Uint8Array(gridSize * gridSize).fill(maxLevel);
  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      if (isReservedCell(x, y, gridSize)) {
        cells[y * gridSize + x] = markerCellValue(x, y, gridSize) ? maxLevel : 0;
      }
    }
  }
  const order = dataCellOrder(gridSize);
  const totalBits = frameBytes.length * 8;
  for (let i = 0; i < order.length; i++) {
    const [x, y] = order[i];
    const bitOffset = i * bpl;
    const level = bitOffset < totalBits ? readBitGroup(frameBytes, bitOffset, bpl) : maxLevel;
    cells[y * gridSize + x] = level;
  }
  return cells;
}

/**
 * Inverse of encodeGridCells: given a sampled cell matrix (level indices
 * 0..levels-1, already resolved from luminance by the caller — see
 * worker.js), extract `byteLength` bytes from the data cells.
 */
export function decodeGridCells(gridSize, cells, byteLength, levels = 2) {
  const bpl = bitsPerLevel(levels);
  const order = dataCellOrder(gridSize);
  const out = new Uint8Array(byteLength);
  const bitsNeeded = byteLength * 8;
  for (let i = 0; i < order.length; i++) {
    const bitOffset = i * bpl;
    if (bitOffset >= bitsNeeded) break;
    const [x, y] = order[i];
    writeBitGroup(out, bitOffset, bpl, cells[y * gridSize + x]);
  }
  return out;
}

/** Map a cell's level index (0..levels-1) to a display/expected luminance
 * byte (0-255), evenly spaced. Used by renderer.js (encode side) and
 * worker.js (decode side, to build classification thresholds). */
export function levelToLuminance(levelIndex, levels) {
  return Math.round((levelIndex * 255) / (levels - 1));
}

/** How many bytes a frame of payloadBytes will actually need to be decoded. */
export function wireByteLength(payloadBytes) {
  return OVERHEAD + payloadBytes;
}

export { frameBits };
