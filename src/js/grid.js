// grid.js — the visual encoding: how a frame's bytes become an N×N grid of
// black/white cells, and how much payload fits per frame at a given grid
// size. Shared by the sender (renderer.js draws it) and the receiver
// (decoder.js / worker.js sample it back).
//
// Layout for an N×N grid:
//   - A 1-cell quiet border (always white) so the marker blocks don't touch
//     the edge of the display / camera crop.
//   - Four MARKER_SIZE×MARKER_SIZE solid corner blocks: top-left, top-right,
//     and bottom-left are BLACK; bottom-right is WHITE. Three-dark-one-light
//     is enough to fix orientation (the odd corner out is always "bottom
//     right") without needing a 4th distinct pattern.
//   - Every remaining cell (in raster order, skipping the border and marker
//     blocks) carries one data bit: black = 0, white = 1.
//
// This is deliberately simpler than a QR code's finder/alignment/timing
// patterns — a QR spends a large fraction of its modules on structure it
// re-derives every symbol. Here the receiver locks onto the corners once
// per calibration and then just re-validates them per frame, so almost
// every remaining cell is payload.

import { OVERHEAD, frameBits } from "./protocol.js";

export const MARKER_SIZE = 4;
export const QUIET = 1;

export function gridCellCount(gridSize) {
  const total = gridSize * gridSize;
  const markerCells = 4 * MARKER_SIZE * MARKER_SIZE;
  const border = 4 * gridSize * QUIET - 4 * QUIET * QUIET; // approx, quiet ring
  return total - markerCells - border;
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

/** Value (0/1, white=1) of a reserved marker cell; undefined if not reserved. */
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

/** Max payload bytes (excluding protocol header/crc) that fit at gridSize. */
export function maxPayloadBytes(gridSize) {
  const bits = dataCellOrder(gridSize).length;
  return Math.max(0, Math.floor(bits / 8) - OVERHEAD);
}

/** Pick the largest grid size (from candidates) whose capacity covers frameBytes. */
export function pickGridSize(payloadBytes, candidates = [48, 64, 96, 128]) {
  for (const g of candidates) {
    if (maxPayloadBytes(g) >= payloadBytes) return g;
  }
  return candidates[candidates.length - 1];
}

/**
 * Build the full N×N cell matrix (Uint8Array, 0/1, white=1) for one wire
 * frame's bytes. Unused trailing data cells (padding) are filled white.
 */
export function encodeGridCells(gridSize, frameBytes) {
  const cells = new Uint8Array(gridSize * gridSize).fill(1);
  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const v = markerCellValue(x, y, gridSize);
      if (v !== undefined && isReservedCell(x, y, gridSize)) cells[y * gridSize + x] = v;
    }
  }
  const order = dataCellOrder(gridSize);
  const totalBits = frameBytes.length * 8;
  for (let bitIdx = 0; bitIdx < order.length; bitIdx++) {
    const [x, y] = order[bitIdx];
    let bit = 1; // padding cells default white (0xFF-ish, harmless — CRC will just not match past real length)
    if (bitIdx < totalBits) {
      const byteIdx = bitIdx >> 3;
      const bitInByte = 7 - (bitIdx & 7);
      bit = (frameBytes[byteIdx] >> bitInByte) & 1;
    }
    cells[y * gridSize + x] = bit;
  }
  return cells;
}

/**
 * Inverse of encodeGridCells: given a sampled cell matrix (0/1, white=1),
 * extract `byteLength` bytes from the data cells.
 */
export function decodeGridCells(gridSize, cells, byteLength) {
  const order = dataCellOrder(gridSize);
  const out = new Uint8Array(byteLength);
  const bitsNeeded = byteLength * 8;
  for (let bitIdx = 0; bitIdx < bitsNeeded && bitIdx < order.length; bitIdx++) {
    const [x, y] = order[bitIdx];
    const bit = cells[y * gridSize + x] & 1;
    if (bit) {
      const byteIdx = bitIdx >> 3;
      const bitInByte = 7 - (bitIdx & 7);
      out[byteIdx] |= 1 << bitInByte;
    }
  }
  return out;
}

/** How many bytes a frame of payloadBytes will actually need to be decoded. */
export function wireByteLength(payloadBytes) {
  return OVERHEAD + payloadBytes;
}

export { frameBits };
