// decoder.js — main-thread side of receiving. Captures video frames as fast
// as the camera actually delivers them (via requestVideoFrameCallback, so
// we're automatically matched to whatever FPS camera.js measured — no
// wasted work re-decoding a frame the camera hasn't updated yet), converts
// each to grayscale, and hands it to worker.js for the CPU-heavy decode.

import { EventEmitter } from "./utils.js";

// Cap the working resolution: bigger doesn't help once it exceeds a few
// pixels per grid cell, and it costs both the main-thread canvas read and
// the worker's per-cell sampling loop. 960px wide comfortably resolves a
// 128x128 grid (~7.5 px/cell) while keeping getImageData/postMessage cheap.
const MAX_WORKING_WIDTH = 960;

export class Decoder extends EventEmitter {
  constructor(video) {
    super();
    this.video = video;
    this.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    this.worker.onmessage = (ev) => this._onWorkerMessage(ev.data);
    this._running = false;
    this._canvas = document.createElement("canvas");
    this._ctx = this._canvas.getContext("2d", { willReadFrequently: true });
    this._bufA = null;
    this._bufB = null;
    this._useA = true;
    this.stats = null;
  }

  start() {
    this._running = true;
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
    const step = (now, meta) => {
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

  _processFrame() {
    const video = this.video;
    if (!video.videoWidth) return;

    const scale = Math.min(1, MAX_WORKING_WIDTH / video.videoWidth);
    const width = Math.max(2, Math.round(video.videoWidth * scale));
    const height = Math.max(2, Math.round(video.videoHeight * scale));

    if (this._canvas.width !== width || this._canvas.height !== height) {
      this._canvas.width = width;
      this._canvas.height = height;
      this._bufA = new Uint8ClampedArray(width * height);
      this._bufB = new Uint8ClampedArray(width * height);
    }

    this._ctx.drawImage(video, 0, 0, width, height);
    const rgba = this._ctx.getImageData(0, 0, width, height).data;

    const out = this._useA ? this._bufA : this._bufB;
    this._useA = !this._useA;
    for (let i = 0, p = 0; p < rgba.length; i++, p += 4) {
      // Rec. 601 luma approximation, integer-friendly.
      out[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
    }

    this.worker.postMessage({ type: "frame", width, height, buffer: out });
    // Note: `out` is one of two reused buffers (ping-pong), so we deliberately
    // do NOT transfer it — transferring would detach it and force a fresh
    // allocation every frame. A structured-clone copy of a <1MB Uint8 buffer
    // is cheap relative to the decode work the worker does with it.
  }

  _onWorkerMessage(msg) {
    switch (msg.type) {
      case "locked":
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
