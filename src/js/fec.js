// fec.js — pluggable "lost packet recovery" strategies.
//
// Three modes, increasing robustness at increasing CPU/overhead cost:
//
//   NONE     — no redundancy. Cheapest, fastest, but a single missed frame
//              means waiting for the stream to loop back around.
//   XOR      — source blocks are grouped (fecParam = group size); one parity
//              frame per group recovers exactly one loss per group. Very
//              cheap to encode/decode, good for occasional single drops.
//   FOUNTAIN — an LT (Luby Transform) rateless fountain code. The sender can
//              emit an unbounded stream of repair symbols; the receiver can
//              reconstruct the whole file from ANY K·(1+ε) symbols regardless
//              of which frames were actually lost, tail or burst. This is
//              the mode recommended by RaptorQ-style designs for exactly
//              this kind of one-way, no-back-channel optical link.
//
// All three expose the same decoder interface (handleFrame / isComplete /
// getBlocks) so decoder.js / worker.js don't need to branch on mode.

import { FrameType } from "./protocol.js";
import { splitmix32, seedFrom, xorInto } from "./utils.js";

// ---------------------------------------------------------------------------
// Robust soliton degree distribution (shared by encoder + decoder — both
// must compute identical CDFs since only the symbol id is transmitted, not
// the index list it covers).
// ---------------------------------------------------------------------------
function robustSolitonCdf(K, c = 0.03, delta = 0.05) {
  const p = new Float64Array(K + 1); // 1-indexed degrees
  p[1] = 1 / K;
  for (let i = 2; i <= K; i++) p[i] = 1 / (i * (i - 1));

  const R = Math.max(1, c * Math.log(K / delta) * Math.sqrt(K));
  const spike = Math.round(K / R);
  const tau = new Float64Array(K + 1);
  for (let i = 1; i < spike; i++) tau[i] = R / (i * K);
  if (spike >= 1 && spike <= K) tau[spike] += (R * Math.log(R / delta)) / K;

  const combined = new Float64Array(K + 1);
  let z = 0;
  for (let i = 1; i <= K; i++) {
    combined[i] = p[i] + tau[i];
    z += combined[i];
  }
  const cdf = new Float64Array(K + 1);
  let acc = 0;
  for (let i = 1; i <= K; i++) {
    acc += combined[i] / z;
    cdf[i] = acc;
  }
  cdf[K] = 1; // guard against floating point drift
  return cdf;
}

function sampleDegree(rng, cdf, K) {
  const x = rng();
  // Linear scan is fine: degree distribution is heavily front-loaded so the
  // common case (degree 1-3) resolves in a handful of comparisons.
  for (let i = 1; i <= K; i++) {
    if (x <= cdf[i]) return i;
  }
  return K;
}

function pickIndices(rng, degree, K) {
  const set = new Set();
  // Soliton degrees skew low, so rejection sampling is cheap in the common
  // case. Guard against the rare high-degree draw pathologically colliding
  // by falling back to sampling the complement once we're past half of K.
  if (degree <= K - degree) {
    while (set.size < degree) set.add(Math.floor(rng() * K));
  } else {
    const excl = new Set();
    while (excl.size < K - degree) excl.add(Math.floor(rng() * K));
    for (let i = 0; i < K; i++) if (!excl.has(i)) set.add(i);
  }
  return set;
}

export class FountainCoder {
  constructor(K, sessionId) {
    this.K = K;
    this.sessionId = sessionId >>> 0;
    this.cdf = robustSolitonCdf(Math.max(K, 2));
  }
  /** Indices a given repair symbolId XORs together — pure function of id. */
  indicesFor(symbolId) {
    const rng = splitmix32(seedFrom(this.sessionId, symbolId >>> 0));
    const degree = Math.min(this.K, sampleDegree(rng, this.cdf, this.K));
    return pickIndices(rng, degree, this.K);
  }
  /** Sender-side: build one repair symbol's payload from the full block set. */
  encodeSymbol(symbolId, sourceBlocks) {
    const indices = this.indicesFor(symbolId);
    const out = new Uint8Array(sourceBlocks[0].length);
    for (const idx of indices) xorInto(out, sourceBlocks[idx]);
    return out;
  }
}

class BaseDecoder {
  constructor(K, blockSize) {
    this.K = K;
    this.blockSize = blockSize;
    this.resolved = new Array(K).fill(null);
    this.resolvedCount = 0;
  }
  isComplete() {
    return this.resolvedCount === this.K;
  }
  getBlocks() {
    return this.resolved;
  }
  _setResolved(idx, value) {
    if (this.resolved[idx] === null) {
      this.resolved[idx] = value;
      this.resolvedCount++;
      return true;
    }
    return false;
  }
}

/** Mode: NONE — just fills in whichever data blocks arrive intact. */
export class NoneDecoder extends BaseDecoder {
  handleFrame(frame) {
    if (frame.type === FrameType.DATA) {
      this._setResolved(frame.frameId, new Uint8Array(frame.payload));
    }
  }
}

/** Mode: XOR — one parity frame recovers one loss per group. */
export class XorDecoder extends BaseDecoder {
  constructor(K, blockSize, groupSize) {
    super(K, blockSize);
    this.groupSize = groupSize;
    this.groups = Math.ceil(K / groupSize);
    this.parity = new Array(this.groups).fill(null);
  }
  _range(g) {
    const start = g * this.groupSize;
    const end = Math.min(this.K, start + this.groupSize);
    return [start, end];
  }
  _tryRecover(g) {
    const [start, end] = this._range(g);
    let missing = -1;
    let missingCount = 0;
    for (let i = start; i < end; i++) {
      if (this.resolved[i] === null) {
        missingCount++;
        missing = i;
      }
    }
    if (missingCount === 0) return;
    if (missingCount === 1 && this.parity[g] !== null) {
      const out = new Uint8Array(this.parity[g]);
      for (let i = start; i < end; i++) {
        if (i !== missing) xorInto(out, this.resolved[i]);
      }
      this._setResolved(missing, out);
    }
  }
  handleFrame(frame) {
    if (frame.type === FrameType.DATA) {
      if (this._setResolved(frame.frameId, new Uint8Array(frame.payload))) {
        this._tryRecover(Math.floor(frame.frameId / this.groupSize));
      }
    } else if (frame.type === FrameType.PARITY) {
      const g = frame.frameId;
      if (this.parity[g] === null) {
        this.parity[g] = new Uint8Array(frame.payload);
        this._tryRecover(g);
      }
    }
  }
}

/** Mode: FOUNTAIN — LT peeling decoder, robust to arbitrary/burst loss. */
export class FountainDecoder extends BaseDecoder {
  constructor(K, blockSize, sessionId) {
    super(K, blockSize);
    this.coder = new FountainCoder(K, sessionId);
    this.equations = new Map(); // eqId -> {indices:Set<number>, value:Uint8Array}
    this.indexToEqs = new Map(); // index -> Set<eqId>
    this._eqCounter = 0;
  }
  _link(idx, eqId) {
    if (!this.indexToEqs.has(idx)) this.indexToEqs.set(idx, new Set());
    this.indexToEqs.get(idx).add(eqId);
  }
  _resolveQueue(queue) {
    while (queue.length) {
      const { idx, value } = queue.shift();
      if (!this._setResolved(idx, value)) continue;
      const eqIds = this.indexToEqs.get(idx);
      this.indexToEqs.delete(idx);
      if (!eqIds) continue;
      for (const eqId of eqIds) {
        const eq = this.equations.get(eqId);
        if (!eq || !eq.indices.has(idx)) continue;
        xorInto(eq.value, value);
        eq.indices.delete(idx);
        if (eq.indices.size === 0) {
          this.equations.delete(eqId);
        } else if (eq.indices.size === 1) {
          const [idx2] = eq.indices;
          this.equations.delete(eqId);
          if (this.resolved[idx2] === null) queue.push({ idx: idx2, value: eq.value });
        }
      }
    }
  }
  _addEquation(indices, value) {
    const idxSet = new Set(indices);
    let work = new Uint8Array(value); // copy; we mutate below
    for (const idx of Array.from(idxSet)) {
      if (this.resolved[idx] !== null) {
        xorInto(work, this.resolved[idx]);
        idxSet.delete(idx);
      }
    }
    if (idxSet.size === 0) return; // redundant / fully implied
    if (idxSet.size === 1) {
      const [idx] = idxSet;
      this._resolveQueue([{ idx, value: work }]);
      return;
    }
    const eqId = this._eqCounter++;
    this.equations.set(eqId, { indices: idxSet, value: work });
    for (const idx of idxSet) this._link(idx, eqId);
  }
  handleFrame(frame) {
    if (this.isComplete()) return;
    if (frame.type === FrameType.DATA) {
      this._addEquation([frame.frameId], frame.payload);
    } else if (frame.type === FrameType.REPAIR) {
      const indices = this.coder.indicesFor(frame.frameId);
      this._addEquation(indices, frame.payload);
    }
  }
}

export function createDecoder(fecMode, K, blockSize, fecParam, sessionId) {
  switch (fecMode) {
    case 1 /* XOR */:
      return new XorDecoder(K, blockSize, Math.max(1, fecParam));
    case 2 /* FOUNTAIN */:
      return new FountainDecoder(K, blockSize, sessionId);
    default:
      return new NoneDecoder(K, blockSize);
  }
}
