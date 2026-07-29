# Video export architecture

## Failure that triggered the rewrite

The previous exporter treated export as a real-time screen recording:

1. a preview WebGL canvas rendered on `requestAnimationFrame`;
2. a second 2D canvas copied that preview and DOM-measured overlays;
3. `captureStream()` fed `MediaRecorder`;
4. audio advanced on an independent `AudioContext` clock;
5. every selected format stayed in memory and multi-format exports were copied
   again into an uncompressed ZIP.

A backgrounded or overloaded tab can throttle `requestAnimationFrame` while the
audio clock and recorder continue. The result is a frozen video track with
working audio. A seven-minute, multi-format export also held hundreds of
megabytes of encoded blobs plus ZIP copies, making a later memory failure likely.

## Current data flow

```text
uploaded audio / captured microphone
              |
              v
       one decoded AudioBuffer
              |
              +--> canonical 64-band spectrum + envelope
              |           |
              |           v
              +--> one fixed-rate analysis timeline
              |                 (reused by every format)
              v
format snapshot --> ShaderRenderer.renderAt(exact timestamp)
                              |
                              v
                    exact-size 2D composite
                              |
                              v
                 CanvasSource.add(timestamp, duration)
                              |
                              v
           WebCodecs + Mediabunny backpressure
                              |
                              v
       1. StreamTarget to selected directory
       2. StreamTarget to OPFS, then browser download
       3. BufferTarget download only as a last resort
```

## Invariants

- Frame `n` is always timestamped `n / fps`; wall-clock speed and tab visibility
  cannot change video duration or frame count.
- The shader receives `snapshot.frame + timestamp * snapshot.speed`.
- Rendering and encoding are sequential and every `CanvasSource.add()` is
  awaited, so encoder pressure cannot create an unbounded queue.
- Only one output resolution and one encoded target are active at a time.
- Every selected resolution is capability-checked before the first output file
  is created, preventing a known unsupported size from leaving a partial batch.
- Each format has a 90-second no-progress watchdog and up to two isolated
  attempts. The retry prefers a software encoder, and a permanently failed
  format is reported without preventing later formats from being attempted.
- A direct-directory file is counted as complete only after finalization and a
  non-zero file-size check. Failed or cancelled partial files are aborted and
  removed with bounded retries.
- Multi-format exports require one writable directory. The app does not silently
  fall back to several delayed automatic browser downloads, which Chrome-family
  browsers may block after the original user activation expires.
- Progress reports the current format, batch position, retry number, and
  completed-file count. A persistent final result states exactly how many
  formats were saved and identifies any failures.
- Uploaded audio is fetched and decoded once per export job.
- The analysis timeline is computed once per export job and reused by all
  selected formats.
- Live and offline audio analysis share one canonical contract: 64 logarithmic
  bands from 40 Hz to 16 kHz, an FFT size of 2048, a -72 dB to -6 dB
  normalization range, and the same `Audio Smoothness` attack/release envelope.
  The live preview evaluates it incrementally; export precomputes it on fixed
  frame timestamps.
- The shader consumes the complete 40 Hz to 16 kHz spectrum. The visible
  waveform samples its own voice-focused 1 kHz to 16 kHz range from that same
  analysis frame, so bass can move the background without collapsing the
  waveform into two disconnected lobes.
- Preview and export use the same pure waveform geometry and bar-height
  functions. Bar width, gap, total span, aspect-ratio height scaling, gain,
  bell profile, vertical gain, and pill radius therefore have one source of
  truth and do not depend on browser viewport pixels.
- Waveform amplitude uses a broad raised-cosine centre profile blended with
  each frame's peak and RMS energy. A soft ceiling preserves detail in loud
  passages without allowing a few centre bars to hard-clip, while true silence
  still produces zero-height bars.
- A single post-profile `WAVEFORM_AMPLITUDE_SCALE` controls the final vertical
  presentation in both DOM preview and canvas export. It is currently `4`, so
  the complete shaped waveform—not only its centre bars—is stretched fourfold.
- Each three-blob visual configuration is expanded into the same eight-anchor
  `A,B,C,A,B,C,A,B` shader chain for preview and export. Control values are
  applied as bounded offsets from the legacy chain, preserving the continuous
  transforming ribbon while keeping every blob control effective.
- Unversioned gallery snapshots keep the legacy frame clamp for visual
  compatibility. Newly saved snapshots use render version 2 and retain their
  complete timeline value.
- Directory output is chunked and backpressured; completed multi-format blobs
  are never accumulated for a ZIP.
- When directory access is unavailable, OPFS is the preferred fallback: encoding
  remains chunked into a temporary origin-private file, and only the completed
  `File` is handed to the browser download.
- `BufferTarget` is allowed only when both directory output and OPFS are
  unavailable. That last-resort path may hold one complete encoded file in JS
  memory, but never multiple selected formats at once.
- Preview animation is stopped during export. Export never reads preview DOM
  geometry and never calls preview `renderExportFrame()`.
- The optional end treatment is a visual-only fade back to the first rendered
  frame. It is disabled whenever audio is attached because it does not make the
  audio track sample-perfectly loopable.
- WebGL, canvas, audio, recorder, stream, and partial-file cleanup run on
  success, error, cancellation, and component unmount.

## Codec policy

- MP4: AVC/H.264 video with AAC audio.
- WebM: VP9 video, with VP8 fallback, and Opus audio.
- Codec capability is checked for the requested output size and bitrate before
  encoding. Unsupported configurations fail with a specific user-facing error.

## Verification

`npm run verify:canvas` checks the current desktop/mobile preview and every
supported aspect ratio. It also compares DOM waveform measurements against the
shared export geometry, verifies the waveform amplitude profile against narrow,
flat, and silent spectra, and checks all eight shader-chain anchors plus every
blob control mapping.

`npm run verify:video` performs a real browser export, probes the container with
`ffprobe`, and checks frame hashes near the beginning, middle, and end with
`ffmpeg`. Its default is a fast 15-second WebM without audio.

Multi-format verifier runs mock the directory picker with a real origin-private
directory handle. This exercises the same seekable `StreamTarget`,
finalization, non-zero validation, and five-file lifecycle as the user-selected
folder path before the files are handed back to the Node test harness for media
probing.

Useful extended runs:

```sh
VIDEO_EXPORT_DURATION_SECONDS=30 npm run verify:video
VIDEO_EXPORT_WITH_AUDIO=1 npm run verify:video
VIDEO_EXPORT_FORMAT=mp4 VIDEO_EXPORT_WITH_AUDIO=1 npm run verify:video
VIDEO_EXPORT_ALL_FORMATS=1 npm run verify:video
npm run verify:video:endurance
npm run verify:video:endurance:mp4
```

The video regression test disables page `requestAnimationFrame` immediately
before export. This makes the original frozen-frame architecture fail while the
fixed-timestep exporter continues normally.

`npm run verify:video:endurance` is deliberately opt-in. It exercises the
original failure shape with a 420-second audio source and four output aspect
ratios, then validates exact frame and packet counts plus moving frame hashes
near the beginning, middle, and end. It defaults to WebM/VP9;
`npm run verify:video:endurance:mp4` runs the same profile through
MP4/H.264/AAC. `npm run verify:video:endurance:all` includes the fifth aspect
ratio. The profile is excluded from the fast default verifier because a real
seven-minute multi-format encode is hardware-dependent and expensive.

## Browser storage behavior

Browsers exposing the File System Access directory picker get bounded-memory,
direct-to-disk output. The exporter chooses a unique filename and removes an
unfinished file when cancellation or failure permits it.

Without directory access, the exporter first uses the Origin Private File System
(OPFS) as a chunked, backpressured staging target. After finalization it starts a
normal browser download from the completed `File`, removes the temporary file
after the download URL is revoked, and opportunistically clears stale export
files older than 24 hours.

Only a browser that exposes neither writable directory access nor OPFS falls
back to a Mediabunny `BufferTarget`. In that final fallback, one encoded file
must fit in JS memory until its download starts; formats are still processed and
released sequentially.
