// worker.js — everything CPU-heavy about receiving happens here, off the
// main thread, so the camera capture loop and UI never stutter regardless
// of grid size or FPS.
//
// The core problem this version fixes: a camera-to-screen link is never
// perfectly still. Hand tremor, breathing, arm fatigue, even a phone's own
// stabilization crop shifting frame-to-frame — all of it moves the sender's
// grid by a few pixels between captured frames. A decoder that samples at
// one fixed, assumed position (correct only for the exact instant it first
// locked) will fail almost every frame after that. So instead of assuming
// the grid stays exactly where the on-screen guide says it should be, we
// actively re-locate it every frame: a cheap coarse-to-fine local search
// (scored by corner-marker contrast alone, not a full decode) finds the
// best nearby position and scale, and only the winning candidate pays for
// a full grid sample + CRC check. This is what makes a *sustained* transfer
// survive real-world hand-held use instead of decoding one lucky frame.
//
// Protocol for talking to decoder.js (main thread):
//   -> {type:'frame', width, height, buffer}   grayscale frame (transferable)
//   -> {type:'reset'}
//   <- {type:'searching', elapsed, bestContrastSeen, reason, searchAttempts}
//   <- {type:'locked', gridSize}
//   <- {type:'meta', meta}
//   <- {type:'stats', resolved, total, uniqueSeen, bytesResolved, fecMode}
//   <- {type:'complete', bytes, fileName, fileSize}
//   <- {type:'error', message}
//   <- {type:'release', buffer}                hands the frame buffer back for reuse

import { parseFrame, FrameType, parseMetaPayload } from "./protocol.js";
import { maxPayloadBytes, dataCellOrder, decodeGridCells, wireByteLength, MARKER_SIZE, QUIET } from "./grid.js";
import { createDecoder } from "./fec.js";
import { crc32 } from "./utils.js";

const GRID_CANDIDATES = [48, 64, 96, 128];
const GUIDE_FRACTION = 0.94; // must match the CSS guide overlay in receiver.html
const MIN_CONTRAST = 18; // out of 255; below this we don't trust a corner read
const MAX_CONSECUTIVE_MISSES = 90; // ~a few seconds of camera frames before giving up a lock
// The search's confidence scoring (see scoreTransform) always assumes this
// many levels, REGARDLESS of what a given frame actually turns out to be
// encoded at. This isn't a guess we need to get right: a binary cell (pure
// 0 or 255) sits exactly on two of the four reference points a 4-level
// metric checks against, so it scores just as confidently there as it
// would under a native 2-level metric — binary content is a subset of
// valid quad readings. Scoring with the wrong (too-low) level count is
// what actually breaks: on a genuinely quad-encoded cell at an
// intermediate level, a 2-level metric sees it as roughly halfway between
// black and white — indistinguishable from a badly-misaligned read — and
// the search loses its only reliable gradient. Since we can't know a
// frame's real type (CALIB/META are always binary, DATA/REPAIR/PARITY use
// the transfer's chosen density) until AFTER we've already found and
// decoded it, always scoring against the ceiling sidesteps the chicken-
// and-egg problem entirely. Must track grid.js's highest supported level
// count if that ever changes.
const MAX_SUPPORTED_LEVELS = 4;

// Guards every outbound message so this module can also be imported under
// plain Node (no `postMessage` global there) to unit-test the pure sampling
// functions below, with zero behavior change inside a real Worker.
function send(msg, transfer) {
  if (typeof postMessage === "function") postMessage(msg, transfer);
}

let state = "searching"; // 'searching' | 'locked' | 'done'
let lockedGridSize = null;
let lastTransform = null; // {x0,y0,cell} — last known-good sample position, tracked frame to frame
let consecutiveMisses = 0;
let sessionId = null;
let meta = null;
let dataLevels = 2; // DATA/REPAIR/PARITY bit depth — known only once META is decoded (CALIB/META are always 2)
let fec = null;
let preMetaQueue = [];
let uniqueSeen = new Set();
let framesSeen = 0;
let framesDecoded = 0;
let startTime = 0;
let bestContrastSeen = 0;
let searchAttempts = 0;
let lastStatsPost = 0;
let lastSearchPost = 0;

function reset() {
  state = "searching";
  lockedGridSize = null;
  lastTransform = null;
  consecutiveMisses = 0;
  sessionId = null;
  meta = null;
  dataLevels = 2;
  fec = null;
  preMetaQueue = [];
  uniqueSeen = new Set();
  framesSeen = 0;
  framesDecoded = 0;
  startTime = performance.now();
  bestContrastSeen = 0;
  searchAttempts = 0;
  lastStatsPost = 0;
  lastSearchPost = 0;
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

/** Cheap: read just the 4 corner markers and score how well they match the
 * expected black/black/black/white pattern. No full grid sampling. Used as
 * a fast first-pass gate (reject candidates with no real signal at all)
 * before the more discriminating confidence scoring below. */
function sampleCorners(gridSize, buffer, width, height, transform) {
  const half = QUIET + MARKER_SIZE / 2 - 0.5;
  const [tlx, tly] = cellCenterPx(transform, half, half);
  const [trx, trY] = cellCenterPx(transform, gridSize - 1 - half, half);
  const [blx, bly] = cellCenterPx(transform, half, gridSize - 1 - half);
  const [brx, bry] = cellCenterPx(transform, gridSize - 1 - half, gridSize - 1 - half);

  const lumaTL = sampleLuma(buffer, width, height, tlx, tly);
  const lumaTR = sampleLuma(buffer, width, height, trx, trY);
  const lumaBL = sampleLuma(buffer, width, height, blx, bly);
  const lumaBR = sampleLuma(buffer, width, height, brx, bry);

  const blackAvg = (lumaTL + lumaTR + lumaBL) / 3;
  const whiteAvg = lumaBR;
  return { blackAvg, whiteAvg, contrast: whiteAvg - blackAvg };
}

// A handful of data cells, spread across the whole grid (not clustered near
// one corner), used to score candidate positions during the local search.
// Cached per gridSize like dataCellOrder itself.
const CONFIDENCE_SAMPLE_COUNT = 24;
const _confidenceIndexCache = new Map();
function confidenceSampleIndices(gridSize) {
  if (_confidenceIndexCache.has(gridSize)) return _confidenceIndexCache.get(gridSize);
  const order = dataCellOrder(gridSize);
  const idx = [];
  for (let i = 0; i < CONFIDENCE_SAMPLE_COUNT; i++) idx.push(Math.floor((i * order.length) / CONFIDENCE_SAMPLE_COUNT));
  _confidenceIndexCache.set(gridSize, idx);
  return idx;
}

/** How close a luminance reading is to the NEAREST of the `levels` expected
 * values (higher = more confident it's a clean, unambiguous read). This is
 * the metric the local search actually optimizes — see the comment on
 * searchTransform for why corner contrast alone isn't enough. Deliberately
 * generalized over `levels`: distance-to-nearest-expected-value, not
 * distance-from-center, so it works correctly for quad mode too (where
 * roughly half of all cells legitimately sit at an intermediate level, not
 * near either extreme — a center-distance metric would wrongly read those
 * as "unconfident" even when perfectly aligned). */
function levelConfidence(luma, blackAvg, whiteAvg, levels) {
  const range = whiteAvg - blackAvg;
  let minDist = Infinity;
  for (let i = 0; i < levels; i++) {
    const expected = blackAvg + (range * i) / (levels - 1);
    const dist = Math.abs(luma - expected);
    if (dist < minDist) minDist = dist;
  }
  return range / (2 * (levels - 1)) - minDist;
}

/** Combined score for one candidate transform: a fast corner-contrast gate
 * (reject candidates with no real signal), then a confidence score summed
 * over a small spread of real data cells. This is what gives the search
 * actual positional sensitivity — see searchTransform's header comment.
 * Always scores against MAX_SUPPORTED_LEVELS (see its comment for why) —
 * this function does not need to know the frame's real density. Returns
 * both the confidence score (for ranking search candidates — NOT
 * comparable to MIN_CONTRAST, it's a different scale) and the raw corner
 * contrast (comparable to MIN_CONTRAST, used for "is there a signal at
 * all" diagnostics). score is -Infinity when the corner gate fails. */
function scoreTransform(gridSize, buffer, width, height, transform) {
  const { blackAvg, whiteAvg, contrast } = sampleCorners(gridSize, buffer, width, height, transform);
  if (contrast < MIN_CONTRAST) return { score: -Infinity, contrast };
  const order = dataCellOrder(gridSize);
  const indices = confidenceSampleIndices(gridSize);
  let sum = 0;
  for (const idx of indices) {
    const [x, y] = order[idx];
    const [px, py] = cellCenterPx(transform, x, y);
    const luma = sampleLuma(buffer, width, height, px, py);
    sum += levelConfidence(luma, blackAvg, whiteAvg, MAX_SUPPORTED_LEVELS);
  }
  return { score: sum, contrast };
}

/**
 * Local re-acquisition search: starting from `baseTransform`, tries nearby
 * positions (coarse pass, then a finer pass around the best coarse result)
 * and a handful of scale factors (recentered on the grid's own middle, so
 * "zooming" doesn't also silently drift the origin). Step sizes are
 * relative to cell size, not fixed pixel counts, so the same code behaves
 * sensibly whether cells are 7px (grid128 on a modest capture width) or
 * 20px (grid48).
 *
 * Candidates are scored by scoreTransform (data-cell confidence), NOT raw
 * corner-marker contrast. This matters: the corner markers are big solid
 * blocks, so sampling anywhere within roughly half a cell of their true
 * center still reads back near-maximum contrast — the score barely changes
 * across a wide range of offsets, including offsets already large enough to
 * scramble the much smaller, more numerous data cells between the markers.
 * A search that ranks candidates by corner contrast alone can "converge" on
 * a position that looks great at the corners and is still wrong everywhere
 * else. Scoring by how cleanly a spread of actual data cells resolve to
 * one of their expected levels gives the search a real gradient to follow
 * toward the position that's actually correct, not just plausible-looking.
 *
 * This is what lets the receiver survive a hand-held camera: instead of
 * trusting that the grid is exactly where it was last frame, it actively
 * re-centers on it every frame.
 */
function searchTransform(gridSize, buffer, width, height, baseTransform) {
  let best = baseTransform;
  let bestResult = scoreTransform(gridSize, buffer, width, height, best);

  // Coarse pass: up to ~0.6 of a cell in each direction.
  const coarse = [-0.6, -0.3, 0, 0.3, 0.6].map((f) => f * baseTransform.cell);
  for (const dx of coarse) {
    for (const dy of coarse) {
      if (dx === 0 && dy === 0) continue;
      const t = { x0: best.x0 + dx, y0: best.y0 + dy, cell: best.cell };
      const result = scoreTransform(gridSize, buffer, width, height, t);
      if (result.score > bestResult.score) {
        bestResult = result;
        best = t;
      }
    }
  }

  // Fine pass, centered on whatever the coarse pass found: up to ~0.2 cell.
  const fineBase = best;
  const fine = [-0.2, -0.1, 0, 0.1, 0.2].map((f) => f * baseTransform.cell);
  for (const dx of fine) {
    for (const dy of fine) {
      if (dx === 0 && dy === 0) continue;
      const t = { x0: fineBase.x0 + dx, y0: fineBase.y0 + dy, cell: best.cell };
      const result = scoreTransform(gridSize, buffer, width, height, t);
      if (result.score > bestResult.score) {
        bestResult = result;
        best = t;
      }
    }
  }

  // Extra-fine pass, centered on the fine pass's result: up to ~0.06 cell.
  // Binary cells tolerate a fair amount of sub-cell blend before crossing
  // their one threshold; quad's 3 thresholds sit three times closer
  // together, so the same residual error that binary shrugs off is often
  // enough to misclassify a quad cell. This extra step buys back that
  // precision — cheap, since it's only ~24 more confidence-score
  // evaluations (not full decodes) on top of what the coarse/fine passes
  // already do.
  const extraFineBase = best;
  const extraFine = [-0.06, -0.03, 0, 0.03, 0.06].map((f) => f * baseTransform.cell);
  for (const dx of extraFine) {
    for (const dy of extraFine) {
      if (dx === 0 && dy === 0) continue;
      const t = { x0: extraFineBase.x0 + dx, y0: extraFineBase.y0 + dy, cell: best.cell };
      const result = scoreTransform(gridSize, buffer, width, height, t);
      if (result.score > bestResult.score) {
        bestResult = result;
        best = t;
      }
    }
  }

  // Scale pass — the phone moving nearer/farther from the screen — recenter
  // on the grid's own midpoint so a scale change doesn't reintroduce drift.
  const centerX = best.x0 + (gridSize / 2) * best.cell;
  const centerY = best.y0 + (gridSize / 2) * best.cell;
  for (const factor of [0.95, 0.975, 1.025, 1.05]) {
    const newCell = best.cell * factor;
    const t = { x0: centerX - (gridSize / 2) * newCell, y0: centerY - (gridSize / 2) * newCell, cell: newCell };
    const result = scoreTransform(gridSize, buffer, width, height, t);
    if (result.score > bestResult.score) {
      bestResult = result;
      best = t;
    }
  }

  // `score` here is a confidence sum (see scoreTransform) — NOT directly
  // comparable to MIN_CONTRAST. Callers should check `isFinite(score)` to
  // know whether any candidate cleared the corner-signal gate at all;
  // `contrast` (the winning candidate's raw corner contrast) is what
  // remains comparable to MIN_CONTRAST, e.g. for "why can't this lock"
  // diagnostics.
  return { transform: best, score: bestResult.score, contrast: bestResult.contrast };
}

/** Map a luminance reading into a level index (0..levels-1), given the
 * measured black/white extremes from this frame's corner markers. For
 * levels=2 this is the original single-midpoint threshold; for levels=4 it
 * places 3 evenly-spaced thresholds across the measured black->white range.
 * This assumes a roughly linear relationship between the values we asked
 * the sender to draw and what the camera reports for them — true enough in
 * practice for 2 bits/cell, though a live per-transfer calibration ramp
 * would do better for anyone pushing beyond 4 levels in the future. */
function classifyLevel(luma, blackAvg, whiteAvg, levels) {
  if (levels <= 2) return luma > (blackAvg + whiteAvg) / 2 ? 1 : 0;
  const range = whiteAvg - blackAvg;
  let level = 0;
  for (let i = 1; i < levels; i++) {
    const threshold = blackAvg + (range * (i - 0.5)) / (levels - 1);
    if (luma > threshold) level = i;
  }
  return level;
}

/** The expensive step: full per-cell sampling + threshold + protocol parse.
 * Only ever called on the winning candidate(s) from searchTransform.
 * `levels` selects how many luminance steps each data cell is classified
 * into (2 = binary, 4 = "quad" high-density mode — see grid.js). */
function sampleAndDecode(gridSize, buffer, width, height, transform, levels = 2) {
  const { blackAvg, whiteAvg, contrast } = sampleCorners(gridSize, buffer, width, height, transform);
  if (contrast < MIN_CONTRAST) return { parsed: null, contrast };

  const order = dataCellOrder(gridSize);
  const cells = new Uint8Array(gridSize * gridSize);
  for (let i = 0; i < order.length; i++) {
    const [x, y] = order[i];
    const [px, py] = cellCenterPx(transform, x, y);
    const luma = sampleLuma(buffer, width, height, px, py);
    cells[y * gridSize + x] = classifyLevel(luma, blackAvg, whiteAvg, levels);
  }

  const capacity = maxPayloadBytes(gridSize, levels);
  const bytes = decodeGridCells(gridSize, cells, wireByteLength(capacity), levels);
  const parsed = parseFrame(bytes);
  return { parsed: parsed.ok ? parsed : null, contrast };
}

// Tried, in order, after the search's own best guess fails to decode —
// see decodeWithNeighborFallback's header comment for why this is needed.
const NEIGHBOR_CELL_OFFSETS = [
  [-1, 0], [1, 0], [0, -1], [0, 1],
  [-1, -1], [1, -1], [-1, 1], [1, 1],
];

/**
 * Decodes at `transform`, trying `primaryLevels` then a binary fallback —
 * and if BOTH fail, retries at each of the 8 neighboring INTEGER-CELL
 * offsets before giving up on this frame.
 *
 * Why this is necessary: the local search's confidence score (see
 * scoreTransform) is excellent at finding *sub-cell* alignment, but it is
 * structurally blind to being off by exactly one whole cell. Every data
 * cell is drawn at one of a few valid luminance levels — so sampling the
 * WRONG (neighboring) cell instead of the right one still reads back a
 * clean, confident level, just the wrong one. When drift carries the true
 * position across a cell boundary between frames, the search can
 * "converge" on a neighboring cell with a confidence score just as high as
 * the correct one — confirmed directly: logging found-vs-true position on
 * failed frames repeatedly showed almost exactly ±1 cell of error in x
 * and/or y. A full decode's CRC32 check can't be fooled this way (a
 * whole-grid shift scrambles every bit), so once the confidence search's
 * top pick fails to actually decode, checking its immediate cell-integer
 * neighbors and letting CRC — not confidence — settle it, resolves the
 * ambiguity the way it should.
 */
function decodeWithNeighborFallback(gridSize, buffer, width, height, transform, primaryLevels) {
  let result = sampleAndDecode(gridSize, buffer, width, height, transform, primaryLevels);
  if (result.parsed) return { result, transform };
  if (primaryLevels !== 2) {
    result = sampleAndDecode(gridSize, buffer, width, height, transform, 2);
    if (result.parsed) return { result, transform };
  }

  for (const [dx, dy] of NEIGHBOR_CELL_OFFSETS) {
    const t = { x0: transform.x0 + dx * transform.cell, y0: transform.y0 + dy * transform.cell, cell: transform.cell };
    let r = sampleAndDecode(gridSize, buffer, width, height, t, primaryLevels);
    if (r.parsed) return { result: r, transform: t };
    if (primaryLevels !== 2) {
      r = sampleAndDecode(gridSize, buffer, width, height, t, 2);
      if (r.parsed) return { result: r, transform: t };
    }
  }

  return { result, transform };
}

/** Bootstrap-search entry point: locates + verifies one grid-size candidate
 * with no prior position to track from (used only in 'searching' state, and
 * by tests). CALIB/META are always binary, so this always assumes levels=2
 * — see the design note in encoder.js's _grid(). Combines the local search
 * with the full decode. */
function tryDecodeCandidate(gridSize, buffer, width, height) {
  const base = transformFor(gridSize, width, height);
  const { transform, score, contrast } = searchTransform(gridSize, buffer, width, height, base);
  if (!isFinite(score)) return { parsed: null, contrast, transform };
  const result = sampleAndDecode(gridSize, buffer, width, height, transform, 2);
  return { parsed: result.parsed, contrast: result.contrast, transform };
}

async function finishIfComplete() {
  if (!fec || !fec.isComplete() || state === "done") return;
  state = "done";
  // Capture meta locally before the only await in this function (gzip
  // decompression) — `meta` is shared module state, and if a `reset()`
  // lands while we're mid-decompression (e.g. the user immediately starts
  // a new scan), reading the shared variable afterward would see null/a
  // different transfer instead of the one we're actually finishing.
  const activeMeta = meta;
  const blocks = fec.getBlocks();
  const total = new Uint8Array(activeMeta.blockSize * blocks.length);
  for (let i = 0; i < blocks.length; i++) total.set(blocks[i], i * activeMeta.blockSize);
  let transferBytes = total.subarray(0, activeMeta.transferSize);

  const actualCrc = crc32(transferBytes);
  if (actualCrc !== activeMeta.fileCrc32) {
    send({ type: "error", message: "Checksum mismatch after reassembly — file may be corrupted." });
    state = "locked";
    return;
  }

  let finalBytes = transferBytes;
  if (activeMeta.compressed) {
    try {
      const ds = new DecompressionStream("gzip");
      const stream = new Blob([transferBytes]).stream().pipeThrough(ds);
      finalBytes = new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) {
      send({ type: "error", message: "Decompression failed: " + e.message });
      state = "locked";
      return;
    }
  }

  send(
    {
      type: "complete",
      bytes: finalBytes,
      fileName: activeMeta.fileName,
      fileSize: activeMeta.fileSize,
    },
    [finalBytes.buffer]
  );
}

function handleParsedFrame(parsed) {
  framesDecoded++;
  const key = `${parsed.sessionId}:${parsed.type}:${parsed.frameId}`;
  if (!uniqueSeen.has(key)) uniqueSeen.add(key);

  if (sessionId === null) sessionId = parsed.sessionId;
  if (parsed.sessionId !== sessionId) {
    // A different transfer started (new sessionId) — if we haven't made any
    // progress on the current one, switch to it; otherwise ignore.
    if (!fec || fec.resolvedCount === 0) {
      sessionId = parsed.sessionId;
      meta = null;
      dataLevels = 2;
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
      dataLevels = meta.levels || 2;
      fec = createDecoder(meta.fecMode, meta.totalBlocks, meta.blockSize, meta.fecParam, sessionId);
      send({ type: "meta", meta });
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

function maybePostStats() {
  const now = performance.now();
  if (now - lastStatsPost < 150) return;
  lastStatsPost = now;
  const elapsed = (now - startTime) / 1000;
  send({
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
    levels: dataLevels,
    fileName: meta ? meta.fileName : null,
  });
}

function maybePostSearching() {
  const now = performance.now();
  if (now - lastSearchPost < 400) return;
  lastSearchPost = now;
  const elapsed = (now - startTime) / 1000;
  let reason;
  if (bestContrastSeen < MIN_CONTRAST * 0.4) reason = "no-signal";
  else if (bestContrastSeen < MIN_CONTRAST) reason = "low-contrast";
  else reason = "unstable";
  send({ type: "searching", elapsed, bestContrastSeen: Math.round(bestContrastSeen), reason, searchAttempts });
}

export {
  transformFor,
  tryDecodeCandidate,
  searchTransform,
  sampleAndDecode,
  sampleCorners,
  decodeWithNeighborFallback,
  handleMessage,
  reset,
};

function handleMessage(msg) {
  if (msg.type === "reset") {
    reset();
    return;
  }
  if (msg.type !== "frame") return;
  if (state === "done") {
    if (msg.buffer) send({ type: "release", buffer: msg.buffer }, [msg.buffer.buffer]);
    return;
  }

  framesSeen++;
  const { width, height, buffer } = msg;

  if (state === "searching") {
    searchAttempts++;
    let locked = false;
    for (const gridSize of GRID_CANDIDATES) {
      const base = transformFor(gridSize, width, height);
      const { transform, score, contrast } = searchTransform(gridSize, buffer, width, height, base);
      if (contrast > bestContrastSeen) bestContrastSeen = contrast;
      if (isFinite(score)) {
        const { result, transform: actualTransform } = decodeWithNeighborFallback(gridSize, buffer, width, height, transform, 2);
        if (result.parsed) {
          lockedGridSize = gridSize;
          lastTransform = actualTransform;
          consecutiveMisses = 0;
          state = "locked";
          send({ type: "locked", gridSize });
          handleParsedFrame(result.parsed);
          locked = true;
          break;
        }
      }
    }
    if (!locked) maybePostSearching();
  } else if (state === "locked") {
    const base = lastTransform || transformFor(lockedGridSize, width, height);
    const { transform, score } = searchTransform(lockedGridSize, buffer, width, height, base);
    let hit = false;
    if (isFinite(score)) {
      // Try the transfer's actual data density first — that's what nearly
      // every frame will be once locked (DATA/REPAIR/PARITY are the bulk of
      // the stream). Only fall back to binary for the occasional CALIB/META
      // repeat, which are always encoded at levels=2 regardless of density.
      // decodeWithNeighborFallback also checks the immediate cell-integer
      // neighbors of `transform` if the direct attempt fails — see its
      // header comment for why that's needed.
      const { result, transform: actualTransform } = decodeWithNeighborFallback(
        lockedGridSize,
        buffer,
        width,
        height,
        transform,
        dataLevels
      );
      if (result.parsed) {
        lastTransform = actualTransform; // track drift — this is the actual fix
        handleParsedFrame(result.parsed);
        hit = true;
      }
    }
    if (hit) {
      consecutiveMisses = 0;
    } else {
      consecutiveMisses++;
      // A handful of misses is normal (motion blur, a blink of glare) — we
      // simply wait for the next frame. Only after sustained failure do we
      // assume the camera moved away and give up the lock, rather than
      // hunting forever around a now-irrelevant position.
      if (consecutiveMisses > MAX_CONSECUTIVE_MISSES) {
        state = "searching";
        lockedGridSize = null;
        lastTransform = null;
        consecutiveMisses = 0;
        bestContrastSeen = 0;
      }
    }
  }

  maybePostStats();
  send({ type: "release", buffer }, [buffer.buffer]);
}

// Registered defensively via `self` (rather than the bare `onmessage`
// global) so this module can also be imported under Node for testing the
// pure sampling/decoding functions above without a Worker global scope.
if (typeof self !== "undefined") {
  self.onmessage = (ev) => handleMessage(ev.data);
}
