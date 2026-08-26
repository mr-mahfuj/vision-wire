// renderer.js — draws the grid-cell frames produced by encoder.js onto a
// <canvas> at a precisely paced, user-adjustable frame rate.
//
// Speed control: the display's own refresh (via requestAnimationFrame) is
// the fastest we can possibly draw, so "speed" is expressed as a target FPS
// that we throttle down to from there. We accumulate elapsed time between
// rAF ticks and only advance to the next frame once the per-frame budget
// (1000/fps ms) has elapsed — this keeps timing accurate even if the
// display refresh rate isn't a clean multiple of the target FPS, and it
// naturally caps out at the display's own refresh rate if the user asks for
// more than that.

import { EventEmitter } from "./utils.js";

export class Renderer extends EventEmitter {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {AsyncGenerator} frameSource  from Transfer.frames()
   */
  constructor(canvas) {
    super();
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    this.fps = 15;
    this._running = false;
    this._raf = null;
    this._lastTick = 0;
    this._accum = 0;
    this._frameCount = 0;
    this._startTime = 0;
    this._currentCells = null;
    this._currentGridSize = 0;

    // Off-screen 1-pixel-per-cell buffer. We paint each frame into this tiny
    // canvas (one putImageData call) then scale it up with nearest-neighbor
    // sampling in a single drawImage call. That's O(1) canvas API calls per
    // frame regardless of grid size, instead of thousands of fillRect calls
    // — the difference between ~60fps and struggling to hit 15fps on a
    // large grid.
    this._small = document.createElement("canvas");
    this._smallCtx = this._small.getContext("2d", { willReadFrequently: false });
    this.ctx.imageSmoothingEnabled = false;
  }

  setFps(fps) {
    this.fps = Math.max(1, Math.min(120, fps));
  }

  async start(transfer, signal) {
    this._running = true;
    this._frameCount = 0;
    this._startTime = performance.now();
    this._lastTick = this._startTime;
    this._accum = 0;

    const iterator = transfer.frames(signal);

    const pump = async () => {
      if (!this._running || signal?.aborted) return;
      const { value, done } = await iterator.next();
      if (done || !value) {
        this.emit("done");
        return;
      }
      this._currentCells = value.cells;
      this._currentGridSize = value.gridSize;
      this._draw(value.cells, value.gridSize);
      this._frameCount++;
      this.emit("frame", {
        kind: value.kind,
        index: value.index,
        loop: value.loop,
        count: this._frameCount,
        elapsed: (performance.now() - this._startTime) / 1000,
      });

      const budget = 1000 / this.fps;
      const now = performance.now();
      const wait = Math.max(0, budget - (now - this._lastTick));
      this._lastTick = now + wait;
      setTimeout(() => pump(), wait);
    };

    pump();
  }

  stop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  redrawCurrent() {
    if (this._currentCells) this._draw(this._currentCells, this._currentGridSize);
  }

  _draw(cells, gridSize) {
    const canvas = this.canvas;
    if (this._small.width !== gridSize) {
      this._small.width = gridSize;
      this._small.height = gridSize;
    }
    // cells is 0/1 with 1=white; expand to RGBA once into a reusable buffer.
    if (!this._imgData || this._imgData.width !== gridSize) {
      this._imgData = this._smallCtx.createImageData(gridSize, gridSize);
    }
    const data = this._imgData.data;
    for (let i = 0; i < cells.length; i++) {
      const v = cells[i] ? 255 : 0;
      const o = i * 4;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
    this._smallCtx.putImageData(this._imgData, 0, 0);

    const size = Math.min(canvas.width, canvas.height);
    const offsetX = (canvas.width - size) / 2;
    const offsetY = (canvas.height - size) / 2;
    const ctx = this.ctx;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(this._small, 0, 0, gridSize, gridSize, offsetX, offsetY, size, size);
  }
}
