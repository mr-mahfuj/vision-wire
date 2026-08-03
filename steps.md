# Project Plan: Screen-to-Camera Optical Data Transfer System

## Overview

**Goal:** Build a system that transfers files between two devices using only a screen and a camera — no network connection required. Data is encoded as visual patterns, displayed at high frame rate, and decoded by a camera on the receiving end.

**Approach:** Start with a simple, reliable QR-code-based prototype, then incrementally replace each bottleneck (encoding density, error handling, synchronization, throughput) until the system evolves into a custom high-speed optical protocol.

**Total estimated timeline:** 10–12 weeks, part-time pace. Can compress to 4–6 weeks with focused full-time work.

---

## Milestone Summary

| Phase | Weeks | Deliverable |
|---|---|---|
| 1. Basic QR transfer | 1–2 | Static file transfer via single QR code |
| 2. Animated QR stream | 3 | Multi-frame QR video stream |
| 3. Packet protocol | 4 | Frame numbering, CRC, sequencing |
| 4. Error correction | 5–6 | Reed–Solomon / RaptorQ recovery |
| 5. Custom binary grid | 7–8 | Replace QR with dense custom encoding |
| 6. Receiver optimization | 9–10 | Fast perspective-corrected pixel sampling |
| 7. Adaptive & concurrent | 11–12 | Adaptive bitrate, multithreading, encryption |

---

## Phase 1: Simplest Working Prototype (Weeks 1–2)

**Objective:** Prove the basic sender → screen → camera → receiver pipeline works end-to-end, even if slow.

**Sender pipeline:**
1. Read input file
2. Optionally compress
3. Split into ~1 KB chunks
4. Encode each chunk as a QR code
5. Display QR codes sequentially at 15–30 FPS

**Receiver pipeline:**
1. Capture camera feed
2. Detect QR code in frame
3. Decode payload
4. Store chunk
5. Reassemble file once all chunks received

**Tech stack:**
- Language: Python (fastest to prototype) or JavaScript (if browser-based)
- `OpenCV` — camera capture, image handling
- `ZXing` or `ZBar` — QR decoding
- `qrcode` library — QR generation

**Success criteria:** A small text file or image can be reliably transferred at low speed with no data loss under good lighting conditions.

**Priority:** Correctness over speed. Don't optimize yet.

---

## Phase 2: Communication Protocol (Week 3–4)

**Objective:** Treat each displayed frame like a network packet so the receiver can detect problems instead of just hoping every frame is captured.

**Frame structure:**

```
+----------------+
| Frame Number   |
+----------------+
| Total Frames   |
+----------------+
| Payload Length |
+----------------+
| Payload        |
+----------------+
| CRC32          |
+----------------+
```

**Capabilities this unlocks:**
- Detect missing frames (gaps in frame numbers)
- Ignore duplicate frames (camera may capture the same displayed frame twice)
- Verify payload integrity via CRC32 before accepting a chunk

**Tasks:**
- Define a binary frame format (fixed header + variable payload)
- Implement CRC32 check on the receiver
- Implement a "missing frame" tracker and request/replay mechanism (if a back-channel exists) or rely on redundancy (see Phase 3)

---

## Phase 3: Error Correction (Weeks 5–6)

**Objective:** Make the system resilient to dropped or misread frames without needing retransmission.

**Concept:** Instead of sending only the original chunks (1, 2, 3, 4, 5), generate redundant packets (1–8) so that losing any 2–3 packets still allows full reconstruction.

**Options, in order of recommendation:**
1. **RaptorQ** — best performance, industry-standard fountain code, used in broadcast/streaming
2. **LT Codes** — simpler fountain code, easier to implement from scratch
3. **Reed–Solomon** — simplest to reason about, good for smaller payloads, higher CPU cost at scale

**Tasks:**
- Integrate a fountain-code or erasure-code library
- Tune redundancy ratio (e.g., 20–40% overhead) based on expected loss rate
- Test recovery under simulated frame loss (randomly drop frames in a test harness)

---

## Phase 4: Replace QR Codes with a Custom Binary Grid (Weeks 7–8)

**Objective:** QR codes waste space on fixed patterns (finder markers, format info, error correction baked in). A custom grid lets you use nearly every cell for data.

**Design:**
- Define a grid size (e.g., 64×64 cells)
- Each cell is black/white (1 bit) or, later, color-coded (2 bits)
- No wasted space on QR-specific structure — you control the entire layout

**Advantages over QR:**
- Higher information density per frame
- No QR library overhead or decoding assumptions
- Full control over the protocol, including how much of the grid is data vs. metadata

**Tasks:**
- Write a custom grid encoder (bits → cell colors)
- Write a matching decoder (cell colors → bits)
- Benchmark information density vs. QR at equivalent frame size

---

## Phase 5: Synchronization Markers (Week 8, overlapping Phase 4)

**Objective:** Without fixed reference points, the receiver can't tell how the grid is rotated, scaled, or positioned in the camera frame.

**Approach:**
- Place distinct markers in the corners of the grid
- Simple option: custom corner glyphs
- Robust option: use **AprilTags** or **ArUco markers**, which have mature, well-tested detection libraries

**Tasks:**
- Add corner markers to the grid layout
- Implement/integrate marker detection on the receiver
- Validate detection under tilt, distance variation, and partial occlusion

---

## Phase 6: Perspective Correction & Receiver Optimization (Weeks 9–10)

**Objective:** Make the receiver fast and robust to real-world camera angles.

**Receiver pipeline:**
1. Find the four corner markers
2. Compute a homography from detected corners to a perfect square
3. Warp the captured image using that homography
4. Threshold the warped image (binarize or color-quantize)
5. Sample each cell directly — no need for expensive per-frame CV decoding logic

**Key OpenCV functions:**
- `findContours()`
- `findHomography()`
- `warpPerspective()`

**Why this matters:** Direct pixel sampling after correction is much faster than running general-purpose QR decoding logic on every frame, which is critical for high frame-rate throughput.

**Tasks:**
- Implement corner detection → homography → warp pipeline
- Implement direct cell sampling and bit extraction
- Profile and optimize this hot path (this is the main bottleneck for real-time throughput)

---

## Phase 7: Adaptive Bitrate, Color, Concurrency, Encryption (Weeks 11–12)

### 7a. Adaptive bitrate
Adjust grid resolution based on observed decode success rate:
- Poor conditions → drop to 48×48
- Good conditions → 64×64 (baseline)
- Excellent conditions → 96×96

Driven by acknowledgments from the receiver or observed error rates over recent frames.

### 7b. Color encoding (optional, higher risk)
Encode more bits per cell using color:
```
Black = 00
Red   = 01
Green = 10
Blue  = 11
```
This can double data density in theory, but display/camera color calibration varies significantly across hardware — treat this as a stretch goal, not a requirement.

### 7c. Pipelining / multithreading
Split the receiver into concurrent stages so throughput isn't limited by sequential processing:

```
Thread 1: Read camera
Thread 2: Perspective correction
Thread 3: Decode grid
Thread 4: Error correction
Thread 5: Write file
```

### 7d. Encryption (optional)
For secure offline transfer:
```
File → AES-256-GCM → Compress → RaptorQ → Frames
```
Only someone with the decryption key can reconstruct the file, even if they capture the full frame stream.

---

## Final Target Architecture

**Sender:**
```
File
 → Compress (Zstd)
 → Encrypt (AES-GCM)
 → Split into chunks
 → RaptorQ encode
 → Build packets
 → Encode as binary grid
 → Add corner markers
 → Display @ up to 120 Hz
```

**Receiver:**
```
Camera capture
 → Detect corner markers
 → Perspective correction
 → Threshold & sample grid
 → Decode packet
 → CRC check
 → RaptorQ decode
 → Decrypt
 → Reconstruct file
```

---

## Full Frame Protocol Spec (Target State)

```
+---------------------------------+
| MAGIC 0xA5B7                    |
+---------------------------------+
| VERSION                         |
+---------------------------------+
| FRAME ID                        |
+---------------------------------+
| TOTAL FRAMES                    |
+---------------------------------+
| PAYLOAD SIZE                    |
+---------------------------------+
| PAYLOAD                         |
+---------------------------------+
| CRC32                           |
+---------------------------------+
```

---

## Skills to Build Along the Way

| Area | Specific topics |
|---|---|
| Computer Vision | OpenCV, homography, perspective transforms, adaptive thresholding, camera calibration |
| Coding Theory | Reed–Solomon, Fountain Codes, RaptorQ, CRC32/CRC64 |
| Image Processing | Bayer patterns, rolling shutter effects, color spaces (RGB/YUV), histogram equalization |
| Compression | Zstandard, Brotli, LZ4 |
| Performance Engineering | SIMD (AVX/NEON), GPU acceleration (OpenGL/Vulkan/Metal), multithreading |

---

## Week-by-Week Timeline

| Weeks | Focus |
|---|---|
| 1–2 | Static QR file transfer (single-frame proof of concept) |
| 3 | Animated QR stream (multi-frame transfer) |
| 4 | Reliable packet protocol: frame numbers, CRC, sequencing |
| 5–6 | Error correction: Reed–Solomon or RaptorQ |
| 7–8 | Replace QR with custom binary grid + sync markers |
| 9–10 | Receiver optimization: OpenCV perspective correction, direct pixel sampling |
| 11–12 | Adaptive bitrate, multithreaded pipeline, optional encryption |

---

## Risk Notes

- **Color encoding** is the highest-risk optimization — display/camera color response varies too much across hardware to be reliable without per-device calibration. Treat as optional.
- **Frame rate ceiling** will be set by display refresh rate, camera capture rate, and rolling shutter effects — test on target hardware early rather than assuming 120 Hz is achievable end-to-end.
- **Lighting and angle sensitivity** should be tested throughout, not just at the end — build a small test harness (fixed camera rig, varying distance/angle/lighting) as early as Phase 1.

---

## Guiding Principle

Validate each layer before adding the next. Each phase builds directly on the reliability of the one before it — skipping ahead (e.g., jumping straight to custom grids without a working QR baseline) makes debugging much harder because you can't isolate whether failures come from encoding, synchronization, or the camera pipeline itself.
