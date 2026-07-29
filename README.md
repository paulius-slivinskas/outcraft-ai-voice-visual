# Outcraft Ambient Generator

React tool for creating procedural Outcraft visuals and exporting stills or
deterministic, audio-reactive videos.

## Stack

- React
- TypeScript
- Vite
- Three.js for WebGL shader rendering
- Mediabunny/WebCodecs for deterministic MP4 and WebM encoding
- shadcn-style UI primitives with Tailwind CSS

## Commands

```sh
npm run dev
npm run build
npm run verify:canvas
npm run verify:video
npm run verify:video:endurance
npm run verify:video:endurance:mp4
```

## Shader Workflow

- The active mesh gradient shader lives in `src/shaders/ambientFragment.ts`.
- The reusable WebGL engine lives in `src/lib/ShaderRenderer.ts`.
- `src/components/ShaderStage.tsx` adapts that engine for the interactive preview.
- The fixed-timestep video pipeline lives in `src/export/`.
- The Paper-inspired preset, palette, and anchor defaults live in `src/data/palette.ts`.
- UI controls live in `src/App.tsx`.

## Video Export

- Video frames use explicit timestamps and are rendered independently from the
  preview, `requestAnimationFrame`, and wall-clock playback.
- Audio files are decoded and analysed once; the same deterministic spectrum
  timeline is reused for every selected aspect ratio.
- Live preview and offline export share the canonical 64-band spectrum contract
  and the same `Audio Smoothness` attack/release envelope.
- Selected formats are encoded sequentially at their true output resolution.
- Multi-format jobs require one selected writable directory and stream every
  output directly into it. Single-format jobs may fall back to a temporary OPFS
  file and one browser download when directory access is unavailable.
- `BufferTarget` is used only when neither directory streaming nor OPFS is
  available, so full-file JS memory buffering is the last-resort path.
- Every selected size is capability-checked before encoding. Each format has a
  no-progress watchdog, one software-encoder retry, non-zero final-file
  validation, and an isolated failure result so one bad target cannot silently
  erase the rest of the queue.
- Cancelling an export aborts analysis, rendering, encoding, and partial-file
  output through one `AbortSignal`.
- Microphone export first captures an audio-only sample, then uses the same
  deterministic offline path as uploaded audio.

See [`docs/video-export-architecture.md`](docs/video-export-architecture.md) for
the failure analysis, invariants, and verification matrix.

## Mesh Controls

- `Format` supports `1:1`, `3:4`, `4:3`, `9:16`, and `16:9`; any combination can be previewed and exported.
- `Speed`, `Scale`, `Distortion`, `Swirl`, and `Blur` mirror the important Paper MeshGradient controls.
- `Frame` sits under playback as an infinite scrubber; after `Pause`, drag left or right to move backward or forward from the paused moment.
- `Grain` starts at `0.05` and can be adjusted manually, while randomizers leave it unchanged; `Grain overlay` stays fixed at `0`.
- `Composition` randomizes anchor positions, influence, warping, and mesh seed without changing colors.
- `Colors` randomizes only the background and anchor colors from the active palette.
- Color controls open palette dropdowns; the original `Paper` palette is preserved, and `Blue Grey` adds the newer muted blue-grey range.
- `Pause` freezes the current animated frame; `Play` resumes from that frame.
- Export supports `PNG 1x`, `PNG 2x`, MP4, and WebM. Video can use
  30/60 FPS, bitrate presets, 15/30/60/120/240-second durations, uploaded audio,
  microphone capture, and an optional visual-only loop fade when no audio is
  attached. Uploaded audio uses its full decoded duration.
- The overlay menu can place the Outcraft star or full logo over the center of the visual, with light or dark logo color.
- The heart button saves the current visual into the persisted gallery with a randomized name.
- Gallery visuals are written immediately to `data/gallery.json`, grouped in accordion sections, and shown three per row.
- Create custom gallery sections and drag saved visuals between them.
- Selecting a gallery item restores its format, mesh, color, and anchor settings in the Generate tab.
