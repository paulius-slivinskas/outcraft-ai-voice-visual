import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const pluginDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(pluginDir, "..");
const srcDir = resolve(pluginDir, "src");
const distDir = resolve(pluginDir, "dist");
const tempDir = resolve(rootDir, "node_modules/.tmp/outcraft-figma-plugin");
const generatedGalleryPath = resolve(srcDir, "gallery-data.ts");

await generateGalleryData();
await buildMain();
await buildUi();

async function generateGalleryData() {
  const galleryPath = resolve(rootDir, "data/gallery.json");
  const gallery = JSON.parse(await readFile(galleryPath, "utf8"));
  const staticGallery = {
    items: (gallery.items ?? []).map((item) => ({
      backgroundColor: item.backgroundColor,
      blobs: item.blobs,
      format: item.format,
      id: item.id,
      mesh: item.mesh,
      name: item.name,
      sectionId: item.sectionId,
    })),
    sections: gallery.sections ?? [],
  };
  const contents = [
    "import type { GalleryState } from \"./types\";",
    "",
    `export const galleryData = ${JSON.stringify(staticGallery, null, 2)} satisfies GalleryState;`,
    "",
  ].join("\n");

  await mkdir(dirname(generatedGalleryPath), { recursive: true });
  await writeFile(generatedGalleryPath, contents, "utf8");
}

async function buildMain() {
  await build({
    build: {
      emptyOutDir: true,
      lib: {
        entry: resolve(srcDir, "code.ts"),
        formats: ["iife"],
        name: "OutcraftStaticVisualsPlugin",
      },
      minify: false,
      outDir: distDir,
      rollupOptions: {
        output: {
          entryFileNames: "code.js",
        },
      },
      target: "es2019",
    },
    configFile: false,
    logLevel: "warn",
    publicDir: false,
  });
}

async function buildUi() {
  await build({
    build: {
      emptyOutDir: true,
      lib: {
        entry: resolve(srcDir, "ui.ts"),
        formats: ["iife"],
        name: "OutcraftStaticVisualsUi",
      },
      minify: false,
      outDir: tempDir,
      rollupOptions: {
        output: {
          entryFileNames: "ui.js",
        },
      },
      target: "es2019",
    },
    configFile: false,
    logLevel: "warn",
    publicDir: false,
  });

  const jsPath = resolve(tempDir, "ui.js");
  const js = await readFile(jsPath, "utf8");
  const css = await readOptionalAssetCss(tempDir);
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <style>${css}</style>
  </head>
  <body>
    <div id="app"></div>
    <script>${js}</script>
  </body>
</html>
`;

  await mkdir(distDir, { recursive: true });
  await writeFile(resolve(distDir, "ui.html"), html, "utf8");
}

async function readOptionalAssetCss(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const cssFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".css"))
    .map((entry) => join(directory, entry.name));

  if (cssFiles.length === 0) {
    return "";
  }

  const chunks = await Promise.all(cssFiles.map((path) => readFile(path, "utf8")));
  return chunks.join("\n");
}
