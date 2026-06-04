# Outcraft Static Visuals Figma Plugin

Generates static ambient PNG visuals from the saved Outcraft gallery and inserts them into the current Figma file as image-filled rectangles.

## Build

```sh
npm run build:figma
```

The build writes:

- `figma-plugin/dist/code.js`
- `figma-plugin/dist/ui.html`

## Load In Figma

1. Open Figma Desktop.
2. Go to `Plugins > Development > Import plugin from manifest...`.
3. Select `figma-plugin/manifest.json`.
4. Run `Outcraft Static Visuals`.

## Notes

- This plugin only creates static raster visuals.
- It uses saved setups from `data/gallery.json`.
- It does not render overlays, logos, buttons, waveform UI, or video.
- The generated rectangle is inserted at the current viewport center.
