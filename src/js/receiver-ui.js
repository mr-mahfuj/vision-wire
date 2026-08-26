// receiver-ui.js — DOM glue for receiver.html.

import { Camera } from "./camera.js";
import { Decoder } from "./decoder.js";
import { formatBytes, formatRate, formatDuration, downloadBlob } from "./utils.js";

const $ = (id) => document.getElementById(id);

const video = $("video");
const viewfinderWrap = $("viewfinderWrap");
const deviceSelect = $("deviceSelect");
const declaredFps = $("declaredFps");
const measuredFps = $("measuredFps");
const remeasureBtn = $("remeasureBtn");
const startBtn = $("startBtn");
const stopBtn = $("stopBtn");
const statusDot = $("statusDot");
const statusText = $("statusText");
const progressFill = $("progressFill");
const fileInfo = $("fileInfo");
const statBlocks = $("statBlocks");
const statFec = $("statFec");
const statThroughput = $("statThroughput");
const statElapsed = $("statElapsed");
const statFramesSeen = $("statFramesSeen");
const emptyState = $("emptyState");

const FEC_LABELS = { 0: "None", 1: "XOR parity", 2: "Fountain (LT)" };

const camera = new Camera(video);
let decoder = null;

function setStatus(text, mode = "idle") {
  statusText.textContent = text;
  statusDot.className = "status-dot" + (mode !== "idle" ? ` ${mode}` : "");
}

// -----------------------------------------------------------------------
// The single biggest cause of "stuck searching for lock": the viewfinder
// box used to be forced square (aspect-ratio: 1/1) regardless of the
// camera's real aspect ratio. object-fit:contain then letterboxed the
// video inside it — invisibly, since the bars are the same black as the
// background — so the dashed alignment guide (a percentage of that square
// box) pointed at a different region than what the decode worker actually
// samples (a percentage of the *raw camera frame*, with no letterboxing).
// Syncing the box to the camera's true aspect ratio makes the two agree.
// -----------------------------------------------------------------------
function syncViewfinderAspect() {
  if (video.videoWidth && video.videoHeight) {
    viewfinderWrap.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  }
}
video.addEventListener("loadedmetadata", syncViewfinderAspect);
video.addEventListener("resize", syncViewfinderAspect);

async function populateDevices() {
  try {
    const devices = await Camera.listDevices();
    deviceSelect.innerHTML = "";
    devices.forEach((d, i) => {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || `Camera ${i + 1}`;
      deviceSelect.appendChild(opt);
    });
    if (devices.length === 0) {
      deviceSelect.innerHTML = "<option>No camera found</option>";
    }
  } catch {
    deviceSelect.innerHTML = "<option>Could not list devices</option>";
  }
}

async function startCameraStream(deviceId) {
  setStatus("Requesting camera…", "warn");
  try {
    const { declaredFps: d, measuredFps: m } = await camera.start(deviceId);
    syncViewfinderAspect();
    declaredFps.textContent = d ? `${d.toFixed(1)} fps` : "—";
    measuredFps.textContent = m ? `${m.toFixed(1)} fps` : "—";
    remeasureBtn.disabled = false;
    startBtn.disabled = false;
    emptyState.style.display = "none";
    setStatus("Camera ready", "idle");
    await populateDevices(); // refresh labels now that permission is granted
    if (deviceId) deviceSelect.value = deviceId;
  } catch (err) {
    setStatus(`Camera error: ${err.message}`, "error");
  }
}

deviceSelect.addEventListener("change", () => startCameraStream(deviceSelect.value));

remeasureBtn.addEventListener("click", async () => {
  remeasureBtn.disabled = true;
  const m = await camera.remeasure();
  measuredFps.textContent = m ? `${m.toFixed(1)} fps` : "—";
  remeasureBtn.disabled = false;
});

const SEARCH_HINTS = {
  "no-signal": "Searching — point the camera at the sender's screen, filling the dashed box.",
  "low-contrast": "Faint signal — increase screen brightness or reduce glare, then hold steady.",
  unstable: "Signal detected but not locking yet — hold the camera steadier or move closer.",
};

startBtn.addEventListener("click", () => {
  startBtn.disabled = true;
  stopBtn.disabled = false;
  fileInfo.textContent = "Searching for signal…";
  statBlocks.textContent = "0 / 0";
  statFec.textContent = "—";
  statThroughput.textContent = "—";
  statFramesSeen.textContent = "0";
  progressFill.style.width = "0%";
  setStatus("Searching for lock…", "warn");

  decoder = new Decoder(video);
  decoder.on("searching", (s) => {
    statFramesSeen.textContent = s.searchAttempts.toLocaleString();
    setStatus(SEARCH_HINTS[s.reason] ?? "Searching…", "warn");
  });
  decoder.on("locked", ({ gridSize }) => {
    setStatus(`Locked — ${gridSize}×${gridSize} grid`, "active");
  });
  decoder.on("meta", (meta) => {
    fileInfo.innerHTML = `<strong>${meta.fileName}</strong><br>${formatBytes(meta.fileSize)}${
      meta.compressed ? " (compressed in transit)" : ""
    }`;
    statFec.textContent = FEC_LABELS[meta.fecMode] ?? "—";
    statBlocks.textContent = `0 / ${meta.totalBlocks}`;
  });
  decoder.on("stats", (s) => {
    statBlocks.textContent = `${s.resolved} / ${s.total}`;
    statFramesSeen.textContent = s.framesSeen.toLocaleString();
    statElapsed.textContent = formatDuration(s.elapsed);
    if (s.elapsed > 0) statThroughput.textContent = formatRate(s.bytesResolved / s.elapsed);
    const pct = s.total ? (s.resolved / s.total) * 100 : 0;
    progressFill.style.width = `${pct}%`;
    if (s.locked && s.total > 0) {
      setStatus(`Receiving — ${s.resolved}/${s.total} blocks`, "active");
    }
  });
  decoder.on("complete", (msg) => {
    setStatus("Transfer complete — file saved", "active");
    const blob = new Blob([msg.bytes]);
    downloadBlob(blob, msg.fileName || "download.bin");
    stopBtn.disabled = true;
    startBtn.disabled = false;
  });
  decoder.on("error", (err) => {
    setStatus(`Error: ${err.message}`, "error");
  });

  decoder.start();
});

stopBtn.addEventListener("click", () => {
  decoder?.destroy();
  decoder = null;
  stopBtn.disabled = true;
  startBtn.disabled = false;
  setStatus("Stopped", "idle");
});

// Kick things off: ask for permission with the default camera so labels
// populate, then let the user switch devices if they have more than one.
(async () => {
  await populateDevices();
  const first = deviceSelect.options[0]?.value;
  await startCameraStream(first || undefined);
})();
