// camera.js — getUserMedia setup, device listing, and FPS auto-detection.
//
// "Detect the scanner device's camera FPS" has two parts:
//   1. What the browser/driver *claims* via track.getCapabilities()/getSettings().
//   2. What frames are *actually delivered* — often lower than claimed under
//      real lighting/USB-bandwidth/CPU conditions. We measure this directly
//      with requestVideoFrameCallback so the recommended sender speed is
//      grounded in reality, not a spec sheet.

import { EventEmitter } from "./utils.js";

export class Camera extends EventEmitter {
  constructor(videoEl) {
    super();
    this.video = videoEl;
    this.stream = null;
    this.track = null;
    this.measuredFps = null;
    this.declaredFps = null;
  }

  static async listDevices() {
    // Labels are only populated after a permission grant; callers should
    // request a stream first if they want human-readable names.
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "videoinput");
  }

  async start(deviceId) {
    this.stop();
    const constraints = {
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        facingMode: deviceId ? undefined : { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 60, min: 15 },
      },
      audio: false,
    };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.video.srcObject = this.stream;
    await this.video.play();
    this.track = this.stream.getVideoTracks()[0];

    const settings = this.track.getSettings?.() ?? {};
    this.declaredFps = settings.frameRate ?? null;

    await this._measureDeliveredFps();
    this.emit("ready", { declaredFps: this.declaredFps, measuredFps: this.measuredFps });
    return { declaredFps: this.declaredFps, measuredFps: this.measuredFps };
  }

  stop() {
    if (this.track) this.track.stop();
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.track = null;
  }

  /** Best current estimate of achievable capture FPS. */
  get effectiveFps() {
    return this.measuredFps ?? this.declaredFps ?? 30;
  }

  /**
   * Measures real, delivered frame rate over a short sampling window using
   * requestVideoFrameCallback (falls back to a rAF-based counter on
   * browsers without rVFC support). Resolves once it has a stable reading.
   */
  _measureDeliveredFps(sampleMs = 900) {
    return new Promise((resolve) => {
      const video = this.video;
      const timestamps = [];
      const finish = () => {
        if (timestamps.length >= 2) {
          const span = (timestamps[timestamps.length - 1] - timestamps[0]) / 1000;
          this.measuredFps = span > 0 ? Math.round(((timestamps.length - 1) / span) * 10) / 10 : null;
        }
        resolve();
      };

      if (typeof video.requestVideoFrameCallback === "function") {
        let cancelled = false;
        const tick = (now) => {
          if (cancelled) return;
          timestamps.push(now);
          if (now - timestamps[0] < sampleMs) {
            video.requestVideoFrameCallback(tick);
          } else {
            finish();
          }
        };
        video.requestVideoFrameCallback(tick);
        setTimeout(() => {
          cancelled = true;
          if (timestamps.length < 2) resolve();
        }, sampleMs + 500);
      } else {
        const start = performance.now();
        const tick = (now) => {
          timestamps.push(now);
          if (now - start < sampleMs) {
            requestAnimationFrame(tick);
          } else {
            finish();
          }
        };
        requestAnimationFrame(tick);
      }
    });
  }

  /** Re-measure on demand (e.g. user pressed "re-check fps" after moving to better light). */
  async remeasure() {
    await this._measureDeliveredFps();
    this.emit("fps-updated", { declaredFps: this.declaredFps, measuredFps: this.measuredFps });
    return this.measuredFps;
  }
}
