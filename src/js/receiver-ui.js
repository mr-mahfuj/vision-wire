// receiver-ui.js — DOM glue for receiver.html.

import { Camera } from "./camera.js";
import { Decoder } from "./decoder.js";
import { formatBytes, formatRate, formatDuration, downloadBlob } from "./utils.js";

const $ = (id) => document.getElementById(id);

const video = $("video");
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
const emptyState = $("emptyState");

const FEC_LABELS = { 0: "None", 1: "XOR parity", 2: "Fountain (LT)" };

const camera = new Camera(video);
let decoder = null;
let currentMeta = null;

function setStatus(text, mode = "idle") {
  statusText.textContent = text;
  statusDot.className = "status-dot" + (mode !== "idle" ? ` ${mode}` : "");
}

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
  } catch (err) {
    deviceSelect.innerHTML = "<option>Could not list devices</option>";
  }
}

async function startCameraStream(deviceId) {
  setStatus("Requesting camera…", "warn");
  try {
    const { declaredFps: d, measuredFps: m } = await camera.start(deviceId);
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

startBtn.addEventListener("click", () => {
  startBtn.disabled = true;
  stopBtn.disabled = false;
  currentMeta = null;
  fileInfo.textContent = "Searching for signal…";
  statBlocks.textContent = "0 / 0";
  statFec.textContent = "—";
  statThroughput.textContent = "—";
  progressFill.style.width = "0%";
  setStatus("Searching for lock…", "warn");

  decoder = new Decoder(video);
  decoder.on("locked", ({ gridSize }) => {
    setStatus(`Locked — ${gridSize}×${gridSize} grid`, "active");
  });
  decoder.on("meta", (meta) => {
    currentMeta = meta;
    fileInfo.innerHTML = `<strong>${meta.fileName}</strong><br>${formatBytes(meta.fileSize)}${
      meta.compressed ? " (compressed in transit)" : ""
    }`;
    statFec.textContent = FEC_LABELS[meta.fecMode] ?? "—";
    statBlocks.textContent = `0 / ${meta.totalBlocks}`;
  });
  decoder.on("stats", (s) => {
    statBlocks.textContent = `${s.resolved} / ${s.total}`;
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
