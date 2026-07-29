import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connect, Plugin } from "vite";
import {
  GalleryLockTimeoutError,
  GalleryPersistence,
  GallerySchemaError,
  type GallerySnapshot,
} from "./server/galleryPersistence";

const galleryFilePath = resolve(
  process.cwd(),
  process.env.OUTCRAFT_GALLERY_FILE ?? "data/gallery.json",
);
const galleryPersistence = new GalleryPersistence(galleryFilePath, {
  lockHeartbeatMs: readPositiveIntegerEnvironmentValue(
    "OUTCRAFT_GALLERY_LOCK_HEARTBEAT_MS",
  ),
  lockRetryMs: readPositiveIntegerEnvironmentValue(
    "OUTCRAFT_GALLERY_LOCK_RETRY_MS",
  ),
  lockStaleMs: readPositiveIntegerEnvironmentValue(
    "OUTCRAFT_GALLERY_LOCK_STALE_MS",
  ),
  lockTimeoutMs: readPositiveIntegerEnvironmentValue(
    "OUTCRAFT_GALLERY_LOCK_TIMEOUT_MS",
  ),
});
const galleryRequestBodyLimit =
  readPositiveIntegerEnvironmentValue("OUTCRAFT_GALLERY_BODY_LIMIT_BYTES") ??
  64 * 1024 * 1024;
const githubRepositoryName = process.env.GITHUB_REPOSITORY?.split("/")[1];
const basePath =
  process.env.GITHUB_PAGES === "true" && githubRepositoryName
    ? `/${githubRepositoryName}/`
    : "/";

export default defineConfig({
  base: basePath,
  build: {
    rollupOptions: {
      input: {
        demo: resolve(process.cwd(), "demo/index.html"),
        main: resolve(process.cwd(), "index.html"),
      },
    },
  },
  plugins: [galleryFilePlugin(), staticGalleryBuildPlugin(), react(), tailwindcss()],
  server: {
    port: 5180,
    watch: {
      ignored: [
        "**/data/gallery*.json",
        "**/data/gallery*.lock",
        "**/data/gallery*.tmp",
      ],
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
      const { state } = await galleryPersistence.readSnapshot();
      const outputPath = resolve(outDir, "data/gallery.json");

      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(
        outputPath,
        `${JSON.stringify(state, null, 2)}\n`,
        "utf8",
      );
    },
  };
}

async function handleGalleryRequest(
  request: IncomingMessage,
  response: ServerResponse,
) {
  try {
    if (request.method === "GET") {
      const snapshot = await galleryPersistence.readSnapshot();

      sendJson(
        response,
        200,
        snapshot.state,
        createGalleryResponseHeaders(snapshot),
      );
      return;
    }

    if (request.method === "PUT") {
      const ifMatch = readIfMatchHeader(request);

      if (!ifMatch) {
        sendJson(
          response,
          428,
          { error: "If-Match is required for gallery writes." },
          noStoreHeaders(),
        );
        return;
      }

      const body = await readRequestBody(request, galleryRequestBodyLimit);
      let nextGalleryState: unknown;

      try {
        nextGalleryState = JSON.parse(body) as unknown;
      } catch {
        sendJson(
          response,
          400,
          { error: "Gallery request body must be valid JSON." },
          noStoreHeaders(),
        );
        return;
      }

      const result = await galleryPersistence.writeIfMatch(
        nextGalleryState,
        ifMatch,
      );
      const headers = createGalleryResponseHeaders(result.snapshot);

      if (result.kind === "conflict") {
        sendJson(
          response,
          409,
          {
            error: "Gallery changed since it was loaded.",
            state: result.snapshot.state,
          },
          headers,
        );
        return;
      }

      sendJson(
        response,
        200,
        { ok: true, state: result.snapshot.state },
        headers,
      );
      return;
    }

    sendJson(
      response,
      405,
      { error: "Method not allowed." },
      { ...noStoreHeaders(), Allow: "GET, PUT" },
    );
  } catch (error) {
    if (error instanceof GallerySchemaError) {
      sendJson(
        response,
        400,
        { error: error.message },
        noStoreHeaders(),
      );
      return;
    }

    if (error instanceof RequestBodyTooLargeError) {
      sendJson(
        response,
        413,
        { error: error.message },
        noStoreHeaders(),
      );
      return;
    }

    if (error instanceof GalleryLockTimeoutError) {
      sendJson(
        response,
        503,
        { error: "Gallery is busy. Retry the save." },
        { ...noStoreHeaders(), "Retry-After": "1" },
      );
      return;
    }

    sendJson(
      response,
      500,
      {
        error: error instanceof Error ? error.message : "Gallery file error.",
      },
      noStoreHeaders(),
    );
  }
}

class RequestBodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`Gallery request body exceeds the ${limit}-byte limit.`);
    this.name = "RequestBodyTooLargeError";
  }
}

async function readRequestBody(request: IncomingMessage, limit: number) {
  const contentLength = Number(request.headers["content-length"]);

  if (Number.isFinite(contentLength) && contentLength > limit) {
    throw new RequestBodyTooLargeError(limit);
  }

  const chunks: Buffer[] = [];
  let byteLength = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

    byteLength += buffer.length;

    if (byteLength > limit) {
      throw new RequestBodyTooLargeError(limit);
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks, byteLength).toString("utf8");
}

function readIfMatchHeader(request: IncomingMessage) {
  const value = request.headers["if-match"];

  return Array.isArray(value) ? value.join(",") : value?.trim();
}

function createGalleryResponseHeaders(snapshot: GallerySnapshot) {
  return {
    ...noStoreHeaders(),
    ETag: snapshot.etag,
    "X-Outcraft-Gallery-Source": snapshot.source,
  };
}

function noStoreHeaders() {
  return {
    "Cache-Control": "no-store",
    Pragma: "no-cache",
  };
}

function sendJson(
  response: ServerResponse,
  status: number,
  data: unknown,
  headers: Record<string, string>,
) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");

  for (const [name, value] of Object.entries(headers)) {
    response.setHeader(name, value);
  }

  response.end(JSON.stringify(data));
}

function readPositiveIntegerEnvironmentValue(name: string) {
  const rawValue = process.env[name];

  if (rawValue === undefined) {
    return undefined;
  }

  const value = Number(rawValue);

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return value;
}
