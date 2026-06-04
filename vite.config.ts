import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connect, Plugin } from "vite";

const defaultGalleryState = {
  items: [],
  sections: [{ id: "favorites", isOpen: true, name: "Favorites" }],
};

const galleryFilePath = resolve(
  process.cwd(),
  process.env.OUTCRAFT_GALLERY_FILE ?? "data/gallery.json",
);
const githubRepositoryName = process.env.GITHUB_REPOSITORY?.split("/")[1];
const basePath =
  process.env.GITHUB_PAGES === "true" && githubRepositoryName
    ? `/${githubRepositoryName}/`
    : "/";

export default defineConfig({
  base: basePath,
  plugins: [galleryFilePlugin(), staticGalleryBuildPlugin(), react(), tailwindcss()],
  server: {
    port: 5180,
    watch: {
      ignored: ["**/data/gallery.json", "**/data/gallery.json.tmp"],
    },
  },
});

function galleryFilePlugin(): Plugin {
  const middleware: Connect.NextHandleFunction = (request, response, next) => {
    const url = new URL(request.url ?? "", "http://localhost");

    if (url.pathname === "/api/gallery") {
      void handleGalleryRequest(request, response);
      return;
    }

    next();
  };

  return {
    name: "outcraft-gallery-file-api",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

function staticGalleryBuildPlugin(): Plugin {
  let outDir = resolve(process.cwd(), "dist");

  return {
    name: "outcraft-static-gallery-build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const gallery = await readFile(galleryFilePath, "utf8").catch(() =>
        `${JSON.stringify(defaultGalleryState, null, 2)}\n`,
      );
      const outputPath = resolve(outDir, "data/gallery.json");

      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, gallery.endsWith("\n") ? gallery : `${gallery}\n`, "utf8");
    },
  };
}

async function handleGalleryRequest(
  request: IncomingMessage,
  response: ServerResponse,
) {
  try {
    if (request.method === "GET") {
      sendJson(response, 200, await readGalleryFile());
      return;
    }

    if (request.method === "PUT") {
      const body = await readRequestBody(request);
      const nextGalleryState = JSON.parse(body) as unknown;

      if (!isGalleryState(nextGalleryState)) {
        sendJson(response, 400, { error: "Invalid gallery state." });
        return;
      }

      await writeGalleryFile(nextGalleryState);
      sendJson(response, 200, { ok: true });
      return;
    }

    response.statusCode = 405;
    response.setHeader("Allow", "GET, PUT");
    response.end();
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : "Gallery file error.",
    });
  }
}

async function readGalleryFile() {
  try {
    const contents = await readFile(galleryFilePath, "utf8");
    const parsedContents = JSON.parse(contents) as unknown;

    return isGalleryState(parsedContents) ? parsedContents : defaultGalleryState;
  } catch {
    await writeGalleryFile(defaultGalleryState);
    return defaultGalleryState;
  }
}

async function writeGalleryFile(galleryState: unknown) {
  await mkdir(dirname(galleryFilePath), { recursive: true });

  const temporaryPath = `${galleryFilePath}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(galleryState, null, 2)}\n`,
    "utf8",
  );
  await rename(temporaryPath, galleryFilePath);
}

async function readRequestBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, status: number, data: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(data));
}

function isGalleryState(value: unknown): value is typeof defaultGalleryState {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    Array.isArray(value.sections)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
