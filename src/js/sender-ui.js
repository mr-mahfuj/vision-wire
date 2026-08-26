// sender-ui.js — DOM glue for sender.html. Keeps UI concerns out of the
// reusable encoder/renderer modules.

import { prepareTransfer } from "./encoder.js";
import { Renderer } from "./renderer.js";
import { formatBytes, formatRate, formatDuration } from "./utils.js";

const $ = (id) => document.getElementById(id);

const fileInput = $("fileInput");
const fileDrop = $("fileDrop");
const fileLabel = $("fileLabel");
const startBtn = $("startBtn");
const stopBtn = $("stopBtn");
const fpsSlider = $("fpsSlider");
const fpsVal = $("fpsVal");
const gridSeg = $("gridSeg");
const fecSeg = $("fecSeg");
const fecParamField = $("fecParamField");
const fecParamSlider = $("fecParamSlider");
const fecParamVal = $("fecParamVal");
const fecParamHint = $("fecParamHint");
const densitySeg = $("densitySeg");
const compressChk = $("compressChk");
const canvas = $("canvas");
const emptyState = $("emptyState");
const statusDot = $("statusDot");
const statusText = $("statusText");
const progressFill = $("progressFill");
const statFrames = $("statFrames");
const statLoop = $("statLoop");
const statThroughput = $("statThroughput");
const statElapsed = $("statElapsed");
const fullscreenBtn = $("fullscreenBtn");
const viewfinderWrap = $("viewfinderWrap");

let selectedFile = null;
let gridSize = "auto";
let fecMode = "xor";
let density = "binary";
let renderer = null;
let abortController = null;
let lastFrameTime = 0;
let bytesTotal = 0;

function resizeCanvas() {
  const rect = viewfinderWrap.getBoundingClientRect();
  const size = Math.round(Math.min(rect.width, rect.height)) || 800;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  if (renderer) renderer.redrawCurrent();
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

fileDrop.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const f = fileInput.files[0];
  if (f) {
    selectedFile = f;
    fileLabel.textContent = `${f.name} — ${formatBytes(f.size)}`;
    fileDrop.classList.add("has-file");
    startBtn.disabled = false;
  }
});

fpsSlider.addEventListener("input", () => {
  fpsVal.textContent = `${fpsSlider.value} fps`;
  if (renderer) renderer.setFps(Number(fpsSlider.value));
});

function segClick(container, onChange) {
  container.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    [...container.children].forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    onChange(btn.dataset.val);
  });
}

segClick(gridSeg, (val) => (gridSize = val));
segClick(fecSeg, (val) => {
  fecMode = val;
  fecParamField.style.display = val === "none" ? "none" : "block";
  if (val === "xor") {
    fecParamSlider.min = 2;
    fecParamSlider.max = 32;
    fecParamSlider.value = 8;
    fecParamHint.textContent = "One parity frame recovers one lost frame per group of this many data frames.";
  } else if (val === "fountain") {
    fecParamSlider.min = 10;
    fecParamSlider.max = 100;
    fecParamSlider.value = 30;
    fecParamHint.textContent = "Repair symbols generated per full pass, as a % of total blocks. Higher survives heavier loss.";
  }
  fecParamVal.textContent = fecParamSlider.value;
});
fecParamSlider.addEventListener("input", () => (fecParamVal.textContent = fecParamSlider.value));
segClick(densitySeg, (val) => (density = val));

fullscreenBtn.addEventListener("click", () => {
  if (!document.fullscreenElement) {
    viewfinderWrap.requestFullscreen?.();
  } else {
    document.exitFullscreen?.();
  }
});
document.addEventListener("fullscreenchange", () => setTimeout(resizeCanvas, 50));

function setStatus(text, mode = "idle") {
  statusText.textContent = text;
  statusDot.className = "status-dot" + (mode !== "idle" ? ` ${mode}` : "");
}

startBtn.addEventListener("click", async () => {
  if (!selectedFile) return;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  emptyState.style.display = "none";
  setStatus("Preparing transfer…", "warn");

  try {
    const transfer = await prepareTransfer(selectedFile, {
      gridSize: gridSize === "auto" ? "auto" : Number(gridSize),
      fecMode,
      fecParam: Number(fecParamSlider.value),
      compress: compressChk.checked,
      density,
    });
    bytesTotal = transfer.totalBytes();

    renderer = new Renderer(canvas);
    renderer.setFps(Number(fpsSlider.value));
    abortController = new AbortController();

    let framesThisSecond = 0;
    let secondStart = performance.now();

    renderer.on("frame", (info) => {
      statFrames.textContent = info.count.toLocaleString();
      statLoop.textContent = info.loop.toLocaleString();
      statElapsed.textContent = formatDuration(info.elapsed);

      // Progress within the current pass: driven directly by which data
      // block we're currently broadcasting (0% at the start of a pass,
      // 100% once all K blocks have gone out and we move into redundancy
      // frames). This is more robust than a running-total modulo, since
      // the very first pass has a longer calibration burst than later
      // ones — a fixed frames-per-loop divisor would drift at that
      // boundary.
      let pct;
      if (info.kind === "data") pct = ((info.index + 1) / transfer.K) * 100;
      else if (info.kind === "calib" || info.kind === "meta") pct = 0;
      else pct = 100; // parity / repair — all data for this pass already sent
      progressFill.style.width = `${pct}%`;

      framesThisSecond++;
      const now = performance.now();
      if (now - secondStart >= 1000) {
        const actualFps = framesThisSecond / ((now - secondStart) / 1000);
        const approxBytesPerFrame = transfer.blockSize;
        statThroughput.textContent = formatRate(actualFps * approxBytesPerFrame);
        framesThisSecond = 0;
        secondStart = now;
      }
      setStatus(`Broadcasting — loop ${info.loop + 1}, ${info.kind} frame`, "active");
    });

    renderer.start(transfer, abortController.signal);
    setStatus("Broadcasting…", "active");
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`, "error");
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
});

stopBtn.addEventListener("click", () => {
  abortController?.abort();
  renderer?.stop();
  stopBtn.disabled = true;
  startBtn.disabled = !selectedFile;
  setStatus("Stopped", "idle");
  emptyState.style.display = "flex";
  progressFill.style.width = "0%";
});
