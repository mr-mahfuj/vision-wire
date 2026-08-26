// decoder.js — main-thread side of receiving. Captures video frames as fast
// as the camera actually delivers them (via requestVideoFrameCallback, so
// we're automatically matched to whatever FPS camera.js measured — no
// wasted work re-decoding a frame the camera hasn't updated yet), converts
// each to grayscale, and hands it to worker.js for the CPU-heavy decode.

import { EventEmitter } from "./utils.js";

// Baseline working resolution before a grid size is known. Once locked,
// bigger grids get bumped up (see WIDTH_FOR_GRID) — more cells means each
// one covers fewer real camera pixels, and the per-frame tracking search in
// worker.js needs a few real pixels of headroom per cell to find sub-cell
// drift reliably, not just the bare minimum to tell black from white.
const BASE_WORKING_WIDTH = 960;
const WIDTH_FOR_GRID = { 48: 800, 64: 960, 96: 1120, 128: 1280 };
// If the worker can't keep up with the camera's delivery rate (a big grid
// on a slower phone), letting every captured frame queue up would make
// latency grow without bound for the rest of the transfer. Capping how
// many frames can be "in flight" at once means we gracefully settle at
// whatever rate the worker can actually sustain instead — we just skip
// capturing a new frame (cheaply, before paying for drawImage/getImageData)
// until the worker reports it has caught up.
const MAX_IN_FLIGHT = 2;

export class Decoder extends EventEmitter {
  constructor(video) {
    super();
    this.video = video;
    this.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    this.worker.onmessage = (ev) => this._onWorkerMessage(ev.data);
    this._running = false;
    this._canvas = document.createElement("canvas");
    this._ctx = this._canvas.getContext("2d", { willReadFrequently: true });
    this._targetWidth = BASE_WORKING_WIDTH;
    // Recycled grayscale buffers, transferred to the worker (zero-copy) and
    // handed back via {type:'release'} once it's done reading them — avoids
    // a fresh allocation + structured-clone copy every single frame, which
    // matters now that each frame also does a local-search tracking pass.
    this._pool = [];
    this.stats = null;
  }

  start() {
    this._running = true;
    this._pool.length = 0;
    this.worker.postMessage({ type: "reset" });
    this._loop();
  }

  stop() {
    this._running = false;
  }

  destroy() {
    this.stop();
    this.worker.terminate();
  }

  _loop() {
    const video = this.video;
    const step = () => {
      if (!this._running) return;
      this._processFrame();
      if (typeof video.requestVideoFrameCallback === "function") {
        video.requestVideoFrameCallback(step);
      } else {
        requestAnimationFrame(step);
      }
    };
    if (typeof video.requestVideoFrameCallback === "function") {
      video.requestVideoFrameCallback(step);
    } else {
      requestAnimationFrame(step);
    }
  }

  _getBuffer(size) {
    for (let i = 0; i < this._pool.length; i++) {
      if (this._pool[i].length === size) return this._pool.splice(i, 1)[0];
    }
    return new Uint8ClampedArray(size);
  }

  _processFrame() {
    const video = this.video;
    if (!video.videoWidth) return;

    const scale = Math.min(1, this._targetWidth / video.videoWidth);
    const width = Math.max(2, Math.round(video.videoWidth * scale));
    const height = Math.max(2, Math.round(video.videoHeight * scale));

    if (this._canvas.width !== width || this._canvas.height !== height) {
      this._canvas.width = width;
      this._canvas.height = height;
      this._pool.length = 0; // old buffers are the wrong size now
    }

    this._ctx.drawImage(video, 0, 0, width, height);
    const rgba = this._ctx.getImageData(0, 0, width, height).data;

    const out = this._getBuffer(width * height);
    for (let i = 0, p = 0; p < rgba.length; i++, p += 4) {
      // Rec. 601 luma approximation, integer-friendly.
      out[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
    }

    // Zero-copy: transfers the underlying ArrayBuffer instead of cloning
    // it. `out` is detached after this call — the worker owns it until it
    // posts it back via {type:'release'}.
    this.worker.postMessage({ type: "frame", width, height, buffer: out }, [out.buffer]);
  }

  _onWorkerMessage(msg) {
    switch (msg.type) {
      case "release":
        if (msg.buffer && msg.buffer.length) {
          this._pool.push(msg.buffer);
          if (this._pool.length > 3) this._pool.length = 3; // don't hoard on a canvas-size change race
        }
        break;
      case "searching":
        this.emit("searching", msg);
        break;
      case "locked":
        // Bigger grids get more capture resolution from here on — more real
        // pixels per cell gives the tracking search room to find sub-cell
        // drift instead of just barely telling black from white.
        this._targetWidth = WIDTH_FOR_GRID[msg.gridSize] || BASE_WORKING_WIDTH;
        this.emit("locked", msg);
        break;
      case "meta":
        this.emit("meta", msg.meta);
        break;
      case "stats":
        this.stats = msg;
        this.emit("stats", msg);
        break;
      case "complete":
        this.emit("complete", msg);
        this.stop();
        break;
      case "error":
        this.emit("error", msg);
        break;
    }
  }
}
