import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  utimes,
} from "node:fs/promises";
import { dirname } from "node:path";

export type GalleryBlobFile = {
  bend: number;
  color: string;
  id: string;
  name: string;
  opacity: number;
  rotation: number;
  size: number;
  stretch: number;
  taper: number;
  x: number;
  y: number;
};

export type GalleryFormatFile = {
  exportHeight?: number;
  exportWidth?: number;
  height: number;
  label: string;
  name: string;
  width: number;
};

export type GalleryMeshFile = {
  audioReactivity?: number;
  audioSmoothness?: number;
  distortion: number;
  frame: number;
  grainMixer: number;
  grainOverlay: number;
  idleWarp?: number;
  motionBlur: number;
  scale: number;
  speed: number;
  swirl: number;
};

export type GalleryOverlayFile = {
  asset: "logo" | "none" | "star" | "waveform";
  bottomRight?: "button" | "qr" | "slogan";
  centerLogoOnly?: boolean;
  centerLogoSize?: "33" | "50";
  showBottomCta?: boolean;
  showBottomLeftSlogan?: boolean;
  showTopLogo?: boolean;
  tone: "dark" | "light";
};

export type GalleryItemFile = {
  backgroundColor: string;
  blobs: GalleryBlobFile[];
  format: GalleryFormatFile;
  id: string;
  mesh: GalleryMeshFile;
  name: string;
  overlay: GalleryOverlayFile;
  renderVersion?: 1 | 2;
  sectionId: string;
  thumbnail: string;
};

export type GallerySectionFile = {
  id: string;
  isOpen: boolean;
  name: string;
};

export type GalleryStateFile = {
  items: GalleryItemFile[];
  sections: GallerySectionFile[];
};

export type GallerySource = "backup" | "default" | "primary" | "recovery";

export type GallerySnapshot = {
  etag: string;
  source: GallerySource;
  state: GalleryStateFile;
};

export type GalleryWriteResult =
  | {
      kind: "conflict";
      snapshot: GallerySnapshot;
    }
  | {
      kind: "saved";
      snapshot: GallerySnapshot;
    };

type LockOwner = {
  createdAt: number;
  pid: number;
  token: string;
};

type GalleryPersistenceOptions = {
  lockHeartbeatMs?: number;
  lockRetryMs?: number;
  lockStaleMs?: number;
  lockTimeoutMs?: number;
};

const stateKeys = new Set(["items", "sections"]);
const sectionKeys = new Set(["id", "isOpen", "name"]);
const itemKeys = new Set([
  "backgroundColor",
  "blobs",
  "format",
  "id",
  "mesh",
  "name",
  "overlay",
  "renderVersion",
  "sectionId",
  "thumbnail",
]);
const blobKeys = new Set([
  "bend",
  "color",
  "id",
  "name",
  "opacity",
  "rotation",
  "size",
  "stretch",
  "taper",
  "x",
  "y",
]);
const formatKeys = new Set([
  "exportHeight",
  "exportWidth",
  "height",
  "label",
  "name",
  "width",
]);
const meshKeys = new Set([
  "audioReactivity",
  "audioSmoothness",
  "distortion",
  "frame",
  "grainMixer",
  "grainOverlay",
  "idleWarp",
  "motionBlur",
  "scale",
  "speed",
  "swirl",
]);
const overlayKeys = new Set([
  "asset",
  "bottomRight",
  "centerLogoOnly",
  "centerLogoSize",
  "showBottomCta",
  "showBottomLeftSlogan",
  "showTopLogo",
  "tone",
]);
const overlayAssets = new Set(["logo", "none", "star", "waveform"]);
const overlayTones = new Set(["dark", "light"]);
const bottomRightOverlays = new Set(["button", "qr", "slogan"]);
const centerLogoSizes = new Set(["33", "50"]);
const defaultLockHeartbeatMs = 5_000;
const defaultLockRetryMs = 40;
const defaultLockStaleMs = 30_000;
const defaultLockTimeoutMs = 10_000;

export const defaultGalleryState: GalleryStateFile = {
  items: [],
  sections: [{ id: "favorites", isOpen: true, name: "Favorites" }],
};

export class GallerySchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GallerySchemaError";
  }
}

export class GalleryLockTimeoutError extends Error {
  constructor(lockPath: string) {
    super(`Gallery write lock timed out: ${lockPath}`);
    this.name = "GalleryLockTimeoutError";
  }
}

class GalleryFileContentError extends Error {
  readonly contents: string;
  readonly filePath: string;

  constructor(filePath: string, contents: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : "Invalid contents.";

    super(`Invalid gallery file ${filePath}: ${reason}`);
    this.name = "GalleryFileContentError";
    this.contents = contents;
    this.filePath = filePath;
  }
}

class GalleryLockLease {
  private compromisedError: Error | null = null;
  private heartbeatRunning = false;
  private readonly heartbeat: ReturnType<typeof setInterval>;

  constructor(
    private readonly lockPath: string,
    private readonly ownerPath: string,
    private readonly owner: LockOwner,
    heartbeatMs: number,
  ) {
    this.heartbeat = setInterval(() => {
      void this.refresh();
    }, heartbeatMs);
    this.heartbeat.unref();
  }

  async assertOwned() {
    if (this.compromisedError) {
      throw this.compromisedError;
    }

    const currentOwner = await readLockOwner(this.ownerPath);

    if (currentOwner?.token !== this.owner.token) {
      throw new Error("Gallery write lock ownership was lost.");
    }
  }

  async release() {
    clearInterval(this.heartbeat);
    const currentOwner = await readLockOwner(this.ownerPath);

    if (currentOwner?.token !== this.owner.token) {
      throw new Error("Gallery write lock ownership was lost before release.");
    }

    await unlink(this.ownerPath);
    await rmdir(this.lockPath);
    await syncDirectory(dirname(this.lockPath));
  }

  private async refresh() {
    if (this.heartbeatRunning || this.compromisedError) {
      return;
    }

    this.heartbeatRunning = true;

    try {
      await this.assertOwned();
      const now = new Date();
      await utimes(this.lockPath, now, now);
    } catch (error) {
      this.compromisedError =
        error instanceof Error ? error : new Error("Gallery lock heartbeat failed.");
    } finally {
      this.heartbeatRunning = false;
    }
  }
}

export class GalleryPersistence {
  readonly backupFilePath: string;
  readonly lockPath: string;
  readonly recoveryFilePath: string;

  private readonly lockHeartbeatMs: number;
  private readonly lockRetryMs: number;
  private readonly lockStaleMs: number;
  private readonly lockTimeoutMs: number;

  constructor(
    readonly filePath: string,
    options: GalleryPersistenceOptions = {},
  ) {
    this.backupFilePath = getGalleryCompanionPath(filePath, "backup");
    this.lockPath = getGalleryCompanionPath(filePath, "lock");
    this.recoveryFilePath = getGalleryCompanionPath(filePath, "recovery");
    this.lockHeartbeatMs =
      options.lockHeartbeatMs ?? defaultLockHeartbeatMs;
    this.lockRetryMs = options.lockRetryMs ?? defaultLockRetryMs;
    this.lockStaleMs = options.lockStaleMs ?? defaultLockStaleMs;
    this.lockTimeoutMs = options.lockTimeoutMs ?? defaultLockTimeoutMs;

    if (
      this.lockHeartbeatMs <= 0 ||
      this.lockRetryMs <= 0 ||
      this.lockStaleMs <= this.lockHeartbeatMs * 2 ||
      this.lockTimeoutMs <= 0
    ) {
      throw new Error("Invalid gallery lock timing configuration.");
    }
  }

  async readSnapshot(): Promise<GallerySnapshot> {
    const stateResult = await this.readStateWithFallback();

    return {
      etag: createGalleryEtag(stateResult.state),
      source: stateResult.source,
      state: stateResult.state,
    };
  }

  async writeIfMatch(
    nextStateValue: unknown,
    ifMatch: string,
  ): Promise<GalleryWriteResult> {
    assertGalleryState(nextStateValue);
    const nextState = nextStateValue;
    const lease = await this.acquireLock();

    try {
      await lease.assertOwned();
      const currentSnapshot = await this.readSnapshot();

      if (!matchesStrongEtag(ifMatch, currentSnapshot.etag)) {
        return { kind: "conflict", snapshot: currentSnapshot };
      }

      const nextEtag = createGalleryEtag(nextState);

      if (
        nextEtag === currentSnapshot.etag &&
        currentSnapshot.source === "primary"
      ) {
        return {
          kind: "saved",
          snapshot: {
            etag: nextEtag,
            source: "primary",
            state: nextState,
          },
        };
      }

      await lease.assertOwned();
      await writeGalleryJsonAtomically(
        this.backupFilePath,
        currentSnapshot.state,
      );
      await lease.assertOwned();
      await writeGalleryJsonAtomically(
        this.recoveryFilePath,
        createGalleryRecoveryState(nextState),
      );
      await lease.assertOwned();
      await writeGalleryJsonAtomically(this.filePath, nextState);
      await lease.assertOwned();

      return {
        kind: "saved",
        snapshot: {
          etag: nextEtag,
          source: "primary",
          state: nextState,
        },
      };
    } finally {
      await lease.release();
    }
  }

  private async acquireLock(): Promise<GalleryLockLease> {
    const deadline = Date.now() + this.lockTimeoutMs;
    const ownerPath = `${this.lockPath}/owner.json`;

    await mkdir(dirname(this.lockPath), { recursive: true });

    while (Date.now() < deadline) {
      const owner: LockOwner = {
        createdAt: Date.now(),
        pid: process.pid,
        token: randomUUID(),
      };

      try {
        await mkdir(this.lockPath);

        try {
          await writeTextFileDurably(
            ownerPath,
            `${JSON.stringify(owner)}\n`,
            true,
          );
          await syncDirectory(this.lockPath);
          await syncDirectory(dirname(this.lockPath));
          return new GalleryLockLease(
            this.lockPath,
            ownerPath,
            owner,
            this.lockHeartbeatMs,
          );
        } catch (error) {
          await rm(this.lockPath, { force: true, recursive: true });
          throw error;
        }
      } catch (error) {
        if (!isFileExistsError(error)) {
          throw error;
        }
      }

      await this.reclaimStaleLock();
      await delay(this.lockRetryMs + Math.floor(Math.random() * this.lockRetryMs));
    }

    throw new GalleryLockTimeoutError(this.lockPath);
  }

  private async readStateWithFallback(): Promise<{
    source: GallerySource;
    state: GalleryStateFile;
  }> {
    const primary = await this.readCandidate(this.filePath);

    if (primary.kind === "valid") {
      return { source: "primary", state: primary.state };
    }

    const [recovery, backup] = await Promise.all([
      this.readCandidate(this.recoveryFilePath),
      this.readCandidate(this.backupFilePath),
    ]);

    if (recovery.kind === "valid") {
      return {
        source: "recovery",
        state:
          backup.kind === "valid"
            ? hydrateRecoveryThumbnails(recovery.state, backup.state)
            : recovery.state,
      };
    }

    if (backup.kind === "valid") {
      return { source: "backup", state: backup.state };
    }

    const failures = [primary, recovery, backup].filter(
      (candidate): candidate is { error: Error; kind: "invalid" } =>
        candidate.kind === "invalid",
    );

    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.error),
        "No valid gallery persistence file is available.",
      );
    }

    return {
      source: "default",
      state: cloneGalleryState(defaultGalleryState),
    };
  }

  private async readCandidate(
    filePath: string,
  ): Promise<
    | { kind: "invalid"; error: Error }
    | { kind: "missing" }
    | { kind: "valid"; state: GalleryStateFile }
  > {
    try {
      return { kind: "valid", state: await readValidGalleryFile(filePath) };
    } catch (error) {
      if (isMissingFileError(error)) {
        return { kind: "missing" };
      }

      const normalizedError =
        error instanceof Error ? error : new Error("Gallery read failed.");

      if (error instanceof GalleryFileContentError) {
        await preserveCorruptContents(error.filePath, error.contents);
      }

      return { error: normalizedError, kind: "invalid" };
    }
  }

  private async reclaimStaleLock() {
    let lockStats;

    try {
      lockStats = await stat(this.lockPath);
    } catch (error) {
      if (isMissingFileError(error)) {
        return;
      }

      throw error;
    }

    if (Date.now() - lockStats.mtimeMs <= this.lockStaleMs) {
      return;
    }

    const ownerPath = `${this.lockPath}/owner.json`;
    const owner = await readLockOwner(ownerPath);

    if (!owner || isProcessAlive(owner.pid)) {
      return;
    }

    const reclaimPath = `${this.lockPath}.reclaim`;

    try {
      await mkdir(reclaimPath);
    } catch (error) {
      if (isFileExistsError(error)) {
        return;
      }

      throw error;
    }

    try {
      const latestStats = await stat(this.lockPath).catch(() => null);
      const latestOwner = await readLockOwner(ownerPath);

      if (
        !latestStats ||
        Date.now() - latestStats.mtimeMs <= this.lockStaleMs ||
        !latestOwner ||
        isProcessAlive(latestOwner.pid)
      ) {
        return;
      }

      const quarantinePath = `${this.lockPath}.stale.${randomUUID()}`;

      await rename(this.lockPath, quarantinePath);
      await rm(quarantinePath, { force: true, recursive: true });
      await syncDirectory(dirname(this.lockPath));
    } finally {
      await rmdir(reclaimPath).catch(() => undefined);
    }
  }
}

export function assertGalleryState(
  value: unknown,
): asserts value is GalleryStateFile {
  assertRecordWithKeys(value, stateKeys, "gallery");
  assertArray(value.sections, "gallery.sections");
  assertArray(value.items, "gallery.items");

  if (value.sections.length === 0) {
    throw new GallerySchemaError("gallery.sections must not be empty.");
  }

  const sectionIds = new Set<string>();

  value.sections.forEach((section, index) => {
    const path = `gallery.sections[${index}]`;

    assertRecordWithKeys(section, sectionKeys, path);
    assertNonEmptyString(section.id, `${path}.id`);
    assertNonEmptyString(section.name, `${path}.name`);
    assertBoolean(section.isOpen, `${path}.isOpen`);

    if (sectionIds.has(section.id)) {
      throw new GallerySchemaError(`${path}.id is duplicated.`);
    }

    sectionIds.add(section.id);
  });

  if (!sectionIds.has("favorites")) {
    throw new GallerySchemaError(
      'gallery.sections must contain the "favorites" section.',
    );
  }

  const itemIds = new Set<string>();

  value.items.forEach((item, index) => {
    const path = `gallery.items[${index}]`;

    assertRecordWithKeys(item, itemKeys, path);
    assertNonEmptyString(item.id, `${path}.id`);
    assertNonEmptyString(item.name, `${path}.name`);
    assertString(item.thumbnail, `${path}.thumbnail`);
    assertNonEmptyString(item.backgroundColor, `${path}.backgroundColor`);
    assertNonEmptyString(item.sectionId, `${path}.sectionId`);

    if (itemIds.has(item.id)) {
      throw new GallerySchemaError(`${path}.id is duplicated.`);
    }

    if (!sectionIds.has(item.sectionId)) {
      throw new GallerySchemaError(
        `${path}.sectionId does not reference an existing section.`,
      );
    }

    itemIds.add(item.id);
    assertGalleryBlobs(item.blobs, `${path}.blobs`);
    assertGalleryFormat(item.format, `${path}.format`);
    assertGalleryMesh(item.mesh, `${path}.mesh`);
    assertGalleryOverlay(item.overlay, `${path}.overlay`);

    if (
      item.renderVersion !== undefined &&
      item.renderVersion !== 1 &&
      item.renderVersion !== 2
    ) {
      throw new GallerySchemaError(`${path}.renderVersion must be 1 or 2.`);
    }
  });
}

export function createGalleryEtag(galleryState: GalleryStateFile) {
  const digest = createHash("sha256")
    .update(serializeGalleryState(galleryState))
    .digest("hex");

  return `"sha256-${digest}"`;
}

export function serializeGalleryState(galleryState: GalleryStateFile) {
  return JSON.stringify(galleryState);
}

function assertGalleryBlobs(value: unknown, path: string) {
  assertArray(value, path);

  if (value.length === 0) {
    throw new GallerySchemaError(`${path} must not be empty.`);
  }

  const blobIds = new Set<string>();

  value.forEach((blob, index) => {
    const blobPath = `${path}[${index}]`;

    assertRecordWithKeys(blob, blobKeys, blobPath);
    assertNonEmptyString(blob.id, `${blobPath}.id`);
    assertNonEmptyString(blob.name, `${blobPath}.name`);
    assertNonEmptyString(blob.color, `${blobPath}.color`);

    for (const key of [
      "bend",
      "opacity",
      "rotation",
      "size",
      "stretch",
      "taper",
      "x",
      "y",
    ] as const) {
      assertFiniteNumber(blob[key], `${blobPath}.${key}`);
    }

    if (blobIds.has(blob.id)) {
      throw new GallerySchemaError(`${blobPath}.id is duplicated.`);
    }

    blobIds.add(blob.id);
  });
}

function assertGalleryFormat(value: unknown, path: string) {
  assertRecordWithKeys(value, formatKeys, path);
  assertNonEmptyString(value.label, `${path}.label`);
  assertNonEmptyString(value.name, `${path}.name`);
  assertPositiveFiniteNumber(value.height, `${path}.height`);
  assertPositiveFiniteNumber(value.width, `${path}.width`);

  if (value.exportHeight !== undefined) {
    assertPositiveInteger(value.exportHeight, `${path}.exportHeight`);
  }

  if (value.exportWidth !== undefined) {
    assertPositiveInteger(value.exportWidth, `${path}.exportWidth`);
  }
}

function assertGalleryMesh(value: unknown, path: string) {
  assertRecordWithKeys(value, meshKeys, path);

  for (const key of [
    "distortion",
    "frame",
    "grainMixer",
    "grainOverlay",
    "motionBlur",
    "scale",
    "speed",
    "swirl",
  ] as const) {
    assertFiniteNumber(value[key], `${path}.${key}`);
  }

  for (const key of [
    "audioReactivity",
    "audioSmoothness",
    "idleWarp",
  ] as const) {
    if (value[key] !== undefined) {
      assertFiniteNumber(value[key], `${path}.${key}`);
    }
  }
}

function assertGalleryOverlay(value: unknown, path: string) {
  assertRecordWithKeys(value, overlayKeys, path);

  if (typeof value.asset !== "string" || !overlayAssets.has(value.asset)) {
    throw new GallerySchemaError(`${path}.asset is invalid.`);
  }

  if (typeof value.tone !== "string" || !overlayTones.has(value.tone)) {
    throw new GallerySchemaError(`${path}.tone is invalid.`);
  }

  if (
    value.bottomRight !== undefined &&
    (typeof value.bottomRight !== "string" ||
      !bottomRightOverlays.has(value.bottomRight))
  ) {
    throw new GallerySchemaError(`${path}.bottomRight is invalid.`);
  }

  if (
    value.centerLogoSize !== undefined &&
    (typeof value.centerLogoSize !== "string" ||
      !centerLogoSizes.has(value.centerLogoSize))
  ) {
    throw new GallerySchemaError(`${path}.centerLogoSize is invalid.`);
  }

  for (const key of [
    "centerLogoOnly",
    "showBottomCta",
    "showBottomLeftSlogan",
    "showTopLogo",
  ] as const) {
    if (value[key] !== undefined) {
      assertBoolean(value[key], `${path}.${key}`);
    }
  }
}

function assertRecordWithKeys(
  value: unknown,
  allowedKeys: Set<string>,
  path: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new GallerySchemaError(`${path} must be an object.`);
  }

  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new GallerySchemaError(`${path}.${key} is not supported.`);
    }
  }
}

function assertArray(
  value: unknown,
  path: string,
): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new GallerySchemaError(`${path} must be an array.`);
  }
}

function assertBoolean(
  value: unknown,
  path: string,
): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new GallerySchemaError(`${path} must be a boolean.`);
  }
}

function assertFiniteNumber(
  value: unknown,
  path: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new GallerySchemaError(`${path} must be a finite number.`);
  }
}

function assertPositiveFiniteNumber(
  value: unknown,
  path: string,
): asserts value is number {
  assertFiniteNumber(value, path);

  if (value <= 0) {
    throw new GallerySchemaError(`${path} must be positive.`);
  }
}

function assertPositiveInteger(
  value: unknown,
  path: string,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new GallerySchemaError(`${path} must be a positive integer.`);
  }
}

function assertString(
  value: unknown,
  path: string,
): asserts value is string {
  if (typeof value !== "string") {
    throw new GallerySchemaError(`${path} must be a string.`);
  }
}

function assertNonEmptyString(
  value: unknown,
  path: string,
): asserts value is string {
  assertString(value, path);

  if (value.trim().length === 0) {
    throw new GallerySchemaError(`${path} must not be empty.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesStrongEtag(ifMatch: string, currentEtag: string) {
  return ifMatch
    .split(",")
    .map((value) => value.trim())
    .some((value) => !value.startsWith("W/") && value === currentEtag);
}

function hydrateRecoveryThumbnails(
  recoveryState: GalleryStateFile,
  backupState: GalleryStateFile,
): GalleryStateFile {
  const backupThumbnails = new Map(
    backupState.items
      .filter((item) => item.thumbnail.length > 0)
      .map((item) => [item.id, item.thumbnail]),
  );

  return {
    items: recoveryState.items.map((item) =>
      item.thumbnail.length > 0
        ? item
        : {
            ...item,
            thumbnail: backupThumbnails.get(item.id) ?? "",
          },
    ),
    sections: recoveryState.sections,
  };
}

function createGalleryRecoveryState(
  galleryState: GalleryStateFile,
): GalleryStateFile {
  return {
    items: galleryState.items.map((item) => ({ ...item, thumbnail: "" })),
    sections: galleryState.sections,
  };
}

async function readValidGalleryFile(filePath: string) {
  const contents = await readFile(filePath, "utf8");

  try {
    const value = JSON.parse(contents) as unknown;

    assertGalleryState(value);
    return value;
  } catch (error) {
    throw new GalleryFileContentError(filePath, contents, error);
  }
}

async function preserveCorruptContents(filePath: string, contents: string) {
  const digest = createHash("sha256").update(contents).digest("hex");
  const archivePath = getCorruptArchivePath(filePath, digest);
  const existingArchive = await readFile(archivePath, "utf8").catch(() => null);

  if (
    existingArchive !== null &&
    createHash("sha256").update(existingArchive).digest("hex") === digest
  ) {
    return;
  }

  await writeTextAtomically(archivePath, contents);
}

async function writeGalleryJsonAtomically(
  filePath: string,
  galleryState: GalleryStateFile,
) {
  assertGalleryState(galleryState);
  await writeTextAtomically(
    filePath,
    `${JSON.stringify(galleryState, null, 2)}\n`,
  );
}

async function writeTextAtomically(filePath: string, contents: string) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await writeTextFileDurably(temporaryPath, contents, true);
    await rename(temporaryPath, filePath);
    await syncDirectory(dirname(filePath));
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function writeTextFileDurably(
  filePath: string,
  contents: string,
  exclusive: boolean,
) {
  const handle = await open(filePath, exclusive ? "wx" : "w", 0o600);

  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directoryPath: string) {
  const handle = await open(directoryPath, "r");

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readLockOwner(ownerPath: string): Promise<LockOwner | null> {
  try {
    const value = JSON.parse(await readFile(ownerPath, "utf8")) as unknown;

    if (
      !isRecord(value) ||
      typeof value.token !== "string" ||
      typeof value.pid !== "number" ||
      !Number.isSafeInteger(value.pid) ||
      typeof value.createdAt !== "number" ||
      !Number.isFinite(value.createdAt)
    ) {
      return null;
    }

    return {
      createdAt: value.createdAt,
      pid: value.pid,
      token: value.token,
    };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === "EPERM";
  }
}

function getGalleryCompanionPath(
  galleryFilePath: string,
  kind: "backup" | "lock" | "recovery",
) {
  return galleryFilePath.endsWith(".json")
    ? `${galleryFilePath.slice(0, -".json".length)}.${kind}${
        kind === "lock" ? "" : ".json"
      }`
    : `${galleryFilePath}.${kind}`;
}

function getCorruptArchivePath(filePath: string, digest: string) {
  return filePath.endsWith(".json")
    ? `${filePath.slice(0, -".json".length)}.corrupt.${digest}.json`
    : `${filePath}.corrupt.${digest}.json`;
}

function cloneGalleryState(galleryState: GalleryStateFile): GalleryStateFile {
  return JSON.parse(JSON.stringify(galleryState)) as GalleryStateFile;
}

function isMissingFileError(error: unknown) {
  return isRecord(error) && error.code === "ENOENT";
}

function isFileExistsError(error: unknown) {
  return isRecord(error) && error.code === "EEXIST";
}

function delay(milliseconds: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
