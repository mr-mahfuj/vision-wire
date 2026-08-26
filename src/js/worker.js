// worker.js — everything CPU-heavy about receiving happens here, off the
// main thread, so the camera capture loop and UI never stutter regardless
// of grid size or FPS.
//
// Protocol for talking to decoder.js (main thread):
//   -> {type:'frame', width, height, buffer}   grayscale frame, transferable
//   -> {type:'reset'}
//   <- {type:'locked', gridSize}
//   <- {type:'stats', resolved, total, uniqueSeen, bytesResolved, fecMode}
//   <- {type:'complete', bytes, fileName, fileSize}
//   <- {type:'error', message}

import { parseFrame, FrameType, parseMetaPayload, wireByteLength } from "./protocol.js";
import { maxPayloadBytes, dataCellOrder, decodeGridCells, MARKER_SIZE, QUIET } from "./grid.js";
import { createDecoder } from "./fec.js";
import { crc32 } from "./utils.js";

const GRID_CANDIDATES = [48, 64, 96, 128];
const GUIDE_FRACTION = 0.94; // must match the CSS guide overlay in receiver.html
const MIN_CONTRAST = 18; // out of 255; below this we don't trust the lock

let state = "searching"; // 'searching' | 'locked' | 'done'
let lockedGridSize = null;
let sessionId = null;
let meta = null;
let fec = null;
let preMetaQueue = [];
let uniqueSeen = new Set();
let framesSeen = 0;
let framesDecoded = 0;
let startTime = 0;

function reset() {
  state = "searching";
  lockedGridSize = null;
  sessionId = null;
  meta = null;
  fec = null;
  preMetaQueue = [];
  uniqueSeen = new Set();
  framesSeen = 0;
  framesDecoded = 0;
  startTime = performance.now();
}
reset();

function transformFor(gridSize, width, height) {
  const guideSize = GUIDE_FRACTION * Math.min(width, height);
  const x0 = (width - guideSize) / 2;
  const y0 = (height - guideSize) / 2;
  return { x0, y0, cell: guideSize / gridSize };
}

/** 3x3 box-average luma sample at a cell-center pixel coordinate. */
function sampleLuma(buffer, width, height, px, py) {
  const cx = Math.round(px);
  const cy = Math.round(py);
  let sum = 0;
  let n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const yy = cy + dy;
    if (yy < 0 || yy >= height) continue;
    const rowOff = yy * width;
    for (let dx = -1; dx <= 1; dx++) {
      const xx = cx + dx;
      if (xx < 0 || xx >= width) continue;
      sum += buffer[rowOff + xx];
      n++;
    }
  }
  return n ? sum / n : buffer[cy * width + cx] || 0;
}

function cellCenterPx(transform, x, y) {
  return [transform.x0 + (x + 0.5) * transform.cell, transform.y0 + (y + 0.5) * transform.cell];
}

/**
 * Attempt to sample+decode one candidate gridSize from the raw grayscale
 * frame. Returns the parsed frame object on success, or null.
 */
function tryDecodeCandidate(gridSize, buffer, width, height) {
  const transform = transformFor(gridSize, width, height);
  const half = (QUIET + MARKER_SIZE / 2) - 0.5;

  const [tlx, tly] = cellCenterPx(transform, half, half);
  const [trx, tryY] = cellCenterPx(transform, gridSize - 1 - half, half);
  const [blx, bly] = cellCenterPx(transform, half, gridSize - 1 - half);
  const [brx, bry] = cellCenterPx(transform, gridSize - 1 - half, gridSize - 1 - half);

  const lumaTL = sampleLuma(buffer, width, height, tlx, tly);
  const lumaTR = sampleLuma(buffer, width, height, trx, tryY);
  const lumaBL = sampleLuma(buffer, width, height, blx, bly);
  const lumaBR = sampleLuma(buffer, width, height, brx, bry);

  const blackAvg = (lumaTL + lumaTR + lumaBL) / 3;
  const whiteAvg = lumaBR;
  if (whiteAvg - blackAvg < MIN_CONTRAST) return null; // no confident lock

  const threshold = (blackAvg + whiteAvg) / 2;
  const order = dataCellOrder(gridSize);
  const cells = new Uint8Array(gridSize * gridSize);
  for (let i = 0; i < order.length; i++) {
    const [x, y] = order[i];
    const [px, py] = cellCenterPx(transform, x, y);
    const luma = sampleLuma(buffer, width, height, px, py);
    cells[y * gridSize + x] = luma > threshold ? 1 : 0;
  }

  const capacity = maxPayloadBytes(gridSize);
  const bytes = decodeGridCells(gridSize, cells, wireByteLength(capacity));
  const parsed = parseFrame(bytes);
  return parsed.ok ? parsed : null;
}

async function finishIfComplete() {
  if (!fec || !fec.isComplete() || state === "done") return;
  state = "done";
  const blocks = fec.getBlocks();
  const total = new Uint8Array(meta.blockSize * blocks.length);
  for (let i = 0; i < blocks.length; i++) total.set(blocks[i], i * meta.blockSize);
  let transferBytes = total.subarray(0, meta.transferSize);

  const actualCrc = crc32(transferBytes);
  if (actualCrc !== meta.fileCrc32) {
    postMessage({ type: "error", message: "Checksum mismatch after reassembly — file may be corrupted." });
    state = "locked";
    return;
  }

  let finalBytes = transferBytes;
  if (meta.compressed) {
    try {
      const ds = new DecompressionStream("gzip");
      const stream = new Blob([transferBytes]).stream().pipeThrough(ds);
      finalBytes = new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) {
      postMessage({ type: "error", message: "Decompression failed: " + e.message });
      state = "locked";
      return;
    }
  }

  postMessage(
    {
      type: "complete",
      bytes: finalBytes,
      fileName: meta.fileName,
      fileSize: meta.fileSize,
    },
    [finalBytes.buffer]
  );
}

function handleParsedFrame(parsed) {
  framesDecoded++;
  const key = `${parsed.sessionId}:${parsed.type}:${parsed.frameId}`;
  const firstTimeSeen = !uniqueSeen.has(key);
  if (firstTimeSeen) uniqueSeen.add(key);

  if (sessionId === null) sessionId = parsed.sessionId;
  if (parsed.sessionId !== sessionId) {
    // A different transfer started (new sessionId) — if we haven't made any
    // progress on the current one, switch to it; otherwise ignore.
    if (!fec || fec.resolvedCount === 0) {
      sessionId = parsed.sessionId;
      meta = null;
      fec = null;
      preMetaQueue = [];
      uniqueSeen = new Set();
    } else {
      return;
    }
  }

  if (parsed.type === FrameType.CALIB) return;

  if (parsed.type === FrameType.META) {
    if (!meta) {
      meta = parseMetaPayload(parsed.payload);
      fec = createDecoder(meta.fecMode, meta.totalBlocks, meta.blockSize, meta.fecParam, sessionId);
      postMessage({ type: "meta", meta });
      // Replay anything we buffered before META arrived.
      for (const f of preMetaQueue) fec.handleFrame(f);
      preMetaQueue = [];
      finishIfComplete();
    }
    return;
  }

  if (!fec) {
    if (preMetaQueue.length < 500) preMetaQueue.push(parsed);
    return;
  }

  if (parsed.type === FrameType.DATA || parsed.type === FrameType.REPAIR || parsed.type === FrameType.PARITY) {
    fec.handleFrame(parsed);
    finishIfComplete();
  }
}

let lastStatsPost = 0;
function maybePostStats() {
  const now = performance.now();
  if (now - lastStatsPost < 150) return;
  lastStatsPost = now;
  const elapsed = (now - startTime) / 1000;
  postMessage({
    type: "stats",
    locked: lockedGridSize !== null,
    gridSize: lockedGridSize,
    resolved: fec ? fec.resolvedCount : 0,
    total: fec ? fec.K : meta?.totalBlocks ?? 0,
    uniqueSeen: uniqueSeen.size,
    framesSeen,
    framesDecoded,
    elapsed,
    bytesResolved: fec ? fec.resolvedCount * (meta?.blockSize ?? 0) : 0,
    totalBytes: meta ? meta.transferSize : 0,
    fecMode: meta ? meta.fecMode : null,
    fileName: meta ? meta.fileName : null,
  });
}

onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === "reset") {
    reset();
    return;
  }
  if (msg.type !== "frame" || state === "done") return;

  framesSeen++;
  const { width, height, buffer } = msg;

  if (state === "searching") {
    for (const gridSize of GRID_CANDIDATES) {
      const parsed = tryDecodeCandidate(gridSize, buffer, width, height);
      if (parsed) {
        lockedGridSize = gridSize;
        state = "locked";
        postMessage({ type: "locked", gridSize });
        handleParsedFrame(parsed);
        break;
      }
    }
  } else if (state === "locked") {
    const parsed = tryDecodeCandidate(lockedGridSize, buffer, width, height);
    if (parsed) {
      handleParsedFrame(parsed);
    }
    // A single miss is normal (motion blur, lighting flicker) — we simply
    // wait for the next captured frame rather than tearing down the lock.
  }

  maybePostStats();
};
