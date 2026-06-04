# Outcraft Ambient Generator

React playground for procedural ambient visuals, mesh gradients, and fragment shader experiments.

## Stack

- React
- TypeScript
- Vite
- Three.js for WebGL shader rendering
- shadcn-style UI primitives with Tailwind CSS

## Commands

```sh
npm run dev
npm run build
npm run verify:canvas
```

## Shader Workflow

- The active mesh gradient shader lives in `src/shaders/ambientFragment.ts`.
- The WebGL bridge lives in `src/components/ShaderStage.tsx`.
- The Paper-inspired preset, palette, and anchor defaults live in `src/data/palette.ts`.
- UI controls live in `src/App.tsx`.

## Mesh Controls

- `Format` frames the visual in `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `9:16`, or `16:9`; `All` shows every format together on the artboard, `Fullscreen` fills the whole background and exports as `1:1`, and `1:1` is the default.
- `Speed`, `Scale`, `Distortion`, `Swirl`, and `Blur` mirror the important Paper MeshGradient controls.
- `Frame` sits under playback as an infinite scrubber; after `Pause`, drag left or right to move backward or forward from the paused moment.
- `Grain` starts at `0.05` and can be adjusted manually, while randomizers leave it unchanged; `Grain overlay` stays fixed at `0`.
- `Composition` randomizes anchor positions, influence, warping, and mesh seed without changing colors.
- `Colors` randomizes only the background and anchor colors from the active palette.
- Color controls open palette dropdowns; the original `Paper` palette is preserved, and `Blue Grey` adds the newer muted blue-grey range.
- `Pause` freezes the current animated frame; `Play` resumes from that frame.
- `Export` opens a menu with `Image` actions for `PNG 1x` and `PNG 2x`, plus `Video` actions for `WEBM` and `MP4`; video exports can be `15`, `30`, or `60` seconds, with an optional loopable ending. In `All` format mode it exports every format as separate files.
- The overlay menu can place the Outcraft star or full logo over the center of the visual, with light or dark logo color.
- The heart button saves the current visual into the persisted gallery with a randomized name.
- Gallery visuals are written immediately to `data/gallery.json`, grouped in accordion sections, and shown three per row.
- Create custom gallery sections and drag saved visuals between them.
- Selecting a gallery item restores its format, mesh, color, and anchor settings in the Generate tab.
