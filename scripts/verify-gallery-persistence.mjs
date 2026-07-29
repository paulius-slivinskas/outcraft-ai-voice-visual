import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const viteBin = resolve(rootDir, "node_modules/vite/bin/vite.js");
const realGalleryPath = resolve(rootDir, "data/gallery.json");
const originalGalleryDigest = await digestFile(realGalleryPath);
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "outcraft-gallery-persistence-"),
);
const galleryPath = join(temporaryDirectory, "gallery.json");
const backupPath = join(temporaryDirectory, "gallery.backup.json");
const recoveryPath = join(temporaryDirectory, "gallery.recovery.json");
const firstPort = await getFreePort();
let secondPort = await getFreePort();

while (secondPort === firstPort) {
  secondPort = await getFreePort();
}

const servers = [];

try {
  servers.push(
    startViteServer(firstPort, galleryPath),
    startViteServer(secondPort, galleryPath),
  );
  await Promise.all(
    servers.map((server) => waitForServer(server.baseUrl, server.process)),
  );

  const firstBaseUrl = servers[0].baseUrl;
  const secondBaseUrl = servers[1].baseUrl;
  const initialResponse = await fetch(`${firstBaseUrl}api/gallery`);
  const initialState = await initialResponse.json();
  const initialEtag = initialResponse.headers.get("etag");

  assert.equal(initialResponse.status, 200);
  assert.equal(initialResponse.headers.get("cache-control"), "no-store");
  assert.equal(initialResponse.headers.get("x-outcraft-gallery-source"), "default");
  assert.deepEqual(initialState, createDefaultGalleryState());
  assert.equal(initialEtag, createExpectedEtag(initialState));

  const missingPreconditionResponse = await putGallery(
    firstBaseUrl,
    createGalleryState(["base"]),
  );

  assert.equal(missingPreconditionResponse.status, 428);

  const invalidSchemaResponse = await putGallery(
    firstBaseUrl,
    {
      items: ["not-a-gallery-item"],
      sections: [{ id: "favorites", isOpen: true, name: "Favorites" }],
    },
    initialEtag,
  );

  assert.equal(invalidSchemaResponse.status, 400);

  const baseState = createGalleryState(["base"]);
  const baseSaveResponse = await putGallery(
    firstBaseUrl,
    baseState,
    initialEtag,
  );
  const baseSaveBody = await baseSaveResponse.json();
  const baseEtag = baseSaveResponse.headers.get("etag");

  assert.equal(baseSaveResponse.status, 200);
  assert.equal(baseEtag, createExpectedEtag(baseState));
  assert.deepEqual(baseSaveBody, { ok: true, state: baseState });

  const secondServerRead = await fetch(`${secondBaseUrl}api/gallery`);

  assert.equal(secondServerRead.headers.get("etag"), baseEtag);
  assert.deepEqual(await secondServerRead.json(), baseState);

  const firstCandidate = createGalleryState(["base", "first-writer"]);
  const secondCandidate = createGalleryState(["base", "second-writer"]);
  const concurrentResponses = await Promise.all([
    putGallery(firstBaseUrl, firstCandidate, baseEtag),
    putGallery(secondBaseUrl, secondCandidate, baseEtag),
  ]);
  const successfulResponses = concurrentResponses.filter(
    (response) => response.status === 200,
  );
  const conflictResponses = concurrentResponses.filter(
    (response) => response.status === 409,
  );

  assert.equal(successfulResponses.length, 1);
  assert.equal(conflictResponses.length, 1);

  const successfulResponse = successfulResponses[0];
  const conflictResponse = conflictResponses[0];
  const successfulBody = await successfulResponse.json();
  const conflictBody = await conflictResponse.json();
  const winningState = successfulBody.state;
  const winningEtag = successfulResponse.headers.get("etag");

  assert.equal(winningEtag, createExpectedEtag(winningState));
  assert.equal(conflictResponse.headers.get("etag"), winningEtag);
  assert.deepEqual(conflictBody.state, winningState);
  assert.equal(typeof conflictBody.error, "string");

  for (const server of servers) {
    const response = await fetch(`${server.baseUrl}api/gallery`);

    assert.equal(response.headers.get("etag"), winningEtag);
    assert.deepEqual(await response.json(), winningState);
  }

  assert.deepEqual(JSON.parse(await readFile(backupPath, "utf8")), baseState);

  const recoveryState = JSON.parse(await readFile(recoveryPath, "utf8"));

  assert.deepEqual(
    recoveryState,
    stripGalleryThumbnails(winningState),
  );

  await writeFile(galleryPath, "{broken-primary", "utf8");

  const recoveryResponse = await fetch(`${firstBaseUrl}api/gallery`);
  const recoveredState = await recoveryResponse.json();
  const expectedRecoveredState = hydrateFromBackup(
    recoveryState,
    baseState,
  );

  assert.equal(recoveryResponse.status, 200);
  assert.equal(
    recoveryResponse.headers.get("x-outcraft-gallery-source"),
    "recovery",
  );
  assert.equal(
    recoveryResponse.headers.get("etag"),
    createExpectedEtag(expectedRecoveredState),
  );
  assert.deepEqual(recoveredState, expectedRecoveredState);
  const recoveryEtag = recoveryResponse.headers.get("etag");
  const selfHealResponse = await putGallery(
    firstBaseUrl,
    recoveredState,
    recoveryEtag,
  );

  assert.equal(selfHealResponse.status, 200);
  assert.equal(selfHealResponse.headers.get("etag"), recoveryEtag);

  const healedPrimaryResponse = await fetch(`${secondBaseUrl}api/gallery`);

  assert.equal(
    healedPrimaryResponse.headers.get("x-outcraft-gallery-source"),
    "primary",
  );
  assert.deepEqual(await healedPrimaryResponse.json(), expectedRecoveredState);

  const archivedFiles = await readdir(temporaryDirectory);

  assert.ok(
    archivedFiles.some(
      (filename) =>
        filename.startsWith("gallery.corrupt.") && filename.endsWith(".json"),
    ),
    "The corrupt primary file was not archived.",
  );

  await writeFile(galleryPath, "{broken-primary-again", "utf8");
  await writeFile(recoveryPath, "{broken-recovery", "utf8");

  const backupResponse = await fetch(`${secondBaseUrl}api/gallery`);

  assert.equal(backupResponse.status, 200);
  assert.equal(
    backupResponse.headers.get("x-outcraft-gallery-source"),
    "backup",
  );
  assert.deepEqual(await backupResponse.json(), expectedRecoveredState);

  await writeFile(backupPath, "{broken-backup", "utf8");

  const exhaustedFallbackResponse = await fetch(
    `${firstBaseUrl}api/gallery`,
  );

  assert.equal(exhaustedFallbackResponse.status, 500);
  assert.notDeepEqual(
    await exhaustedFallbackResponse.json(),
    createDefaultGalleryState(),
  );

  const buildResult = spawnSync(
    process.execPath,
    [viteBin, "build", "--outDir", join(temporaryDirectory, "dist")],
    {
      cwd: rootDir,
      encoding: "utf8",
      env: createServerEnvironment(galleryPath),
      timeout: 30_000,
    },
  );

  assert.notEqual(
    buildResult.status,
    0,
    "A build with no valid gallery source must fail instead of emitting empty data.",
  );

  console.log(
    "gallery persistence: ETag, schema, cross-process conflict, backup, recovery, and corrupt fallback passed",
  );
} finally {
  await Promise.all(servers.map((server) => stopServer(server.process)));
  await rm(temporaryDirectory, { force: true, recursive: true });
  assert.equal(
    await digestFile(realGalleryPath),
    originalGalleryDigest,
    "The real data/gallery.json changed during the isolated persistence test.",
  );
}

function startViteServer(port, sharedGalleryPath) {
  const child = spawn(
    process.execPath,
    [
      viteBin,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: rootDir,
      env: createServerEnvironment(sharedGalleryPath),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  const appendOutput = (chunk) => {
    output += chunk.toString();
  };

  child.stdout.on("data", appendOutput);
  child.stderr.on("data", appendOutput);

  return {
    baseUrl: `http://127.0.0.1:${port}/`,
    getOutput: () => output,
    process: child,
  };
}

function createServerEnvironment(sharedGalleryPath) {
  return {
    ...process.env,
    OUTCRAFT_GALLERY_FILE: sharedGalleryPath,
    OUTCRAFT_GALLERY_LOCK_HEARTBEAT_MS: "100",
    OUTCRAFT_GALLERY_LOCK_RETRY_MS: "10",
    OUTCRAFT_GALLERY_LOCK_STALE_MS: "1000",
    OUTCRAFT_GALLERY_LOCK_TIMEOUT_MS: "5000",
  };
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Vite server exited with code ${child.exitCode}.`);
    }

    try {
      const response = await fetch(`${baseUrl}api/gallery`);

      if (response.ok) {
        return;
      }
    } catch {
      // The process is still starting.
    }

    await delay(50);
  }

  throw new Error(`Vite server did not start at ${baseUrl}.`);
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");

  await Promise.race([
    new Promise((resolveClose) => {
      child.once("close", resolveClose);
    }),
    delay(3_000),
  ]);

  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

async function putGallery(baseUrl, state, ifMatch) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  if (ifMatch) {
    headers["If-Match"] = ifMatch;
  }

  return fetch(`${baseUrl}api/gallery`, {
    body: JSON.stringify(state),
    headers,
    method: "PUT",
  });
}

function createDefaultGalleryState() {
  return {
    items: [],
    sections: [{ id: "favorites", isOpen: true, name: "Favorites" }],
  };
}

function createGalleryState(itemIds) {
  return {
    items: itemIds.map((id, index) => createGalleryItem(id, index)),
    sections: [{ id: "favorites", isOpen: true, name: "Favorites" }],
  };
}

function createGalleryItem(id, index) {
  return {
    backgroundColor: "#03080f",
    blobs: [
      {
        bend: 0,
        color: "#ffffff",
        id: `${id}-blob`,
        name: "Anchor",
        opacity: 1,
        rotation: 0,
        size: 0.5,
        stretch: 1,
        taper: 0,
        x: 0.5,
        y: 0.5,
      },
    ],
    format: {
      exportHeight: 1080,
      exportWidth: 1080,
      height: 1,
      label: "1:1",
      name: "1080 x 1080 px",
      width: 1,
    },
    id,
    mesh: {
      audioReactivity: 45,
      audioSmoothness: 18,
      distortion: 0.5,
      frame: index * 100,
      grainMixer: 0.05,
      grainOverlay: 0,
      idleWarp: 0.35,
      motionBlur: 0,
      scale: 1,
      speed: 0.5,
      swirl: 0.1,
    },
    name: `Preset ${id}`,
    overlay: {
      asset: "waveform",
      bottomRight: "button",
      centerLogoOnly: false,
      centerLogoSize: "33",
      showBottomCta: true,
      showBottomLeftSlogan: true,
      showTopLogo: true,
      tone: "light",
    },
    renderVersion: 2,
    sectionId: "favorites",
    thumbnail: `data:image/png;base64,${Buffer.from(id).toString("base64")}`,
  };
}

function stripGalleryThumbnails(state) {
  return {
    items: state.items.map((item) => ({ ...item, thumbnail: "" })),
    sections: state.sections,
  };
}

function hydrateFromBackup(recoveryState, backupState) {
  const thumbnails = new Map(
    backupState.items.map((item) => [item.id, item.thumbnail]),
  );

  return {
    items: recoveryState.items.map((item) => ({
      ...item,
      thumbnail: item.thumbnail || thumbnails.get(item.id) || "",
    })),
    sections: recoveryState.sections,
  };
}

function createExpectedEtag(state) {
  const digest = createHash("sha256")
    .update(JSON.stringify(state))
    .digest("hex");

  return `"sha256-${digest}"`;
}

async function digestFile(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

async function getFreePort() {
  const server = createServer();

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not allocate a local test port.");
  }

  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) {
        rejectClose(error);
      } else {
        resolveClose();
      }
    });
  });

  return address.port;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}
