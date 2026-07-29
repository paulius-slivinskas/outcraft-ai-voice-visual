import {
  BufferTarget,
  StreamTarget,
  type StreamTargetChunk,
  type Target,
} from "mediabunny";

const downloadUrlLifetimeMs = 60_000;
const streamChunkSizeBytes = 8 * 1024 * 1024;
const opfsTemporaryPrefix = "outcraft-export-";
const staleOpfsFileAgeMs = 24 * 60 * 60 * 1000;

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: "read" | "readwrite";
    startIn?: WellKnownDirectory | FileSystemHandle;
  }) => Promise<FileSystemDirectoryHandle>;
};

type WellKnownDirectory =
  | "desktop"
  | "documents"
  | "downloads"
  | "music"
  | "pictures"
  | "videos";

export type VideoOutputFile = {
  discard: () => Promise<void>;
  finish: (mimeType: string) => Promise<CompletedVideoOutputFile>;
  target: Target;
};

export type CompletedVideoOutputFile = {
  filename: string;
  sizeBytes: number;
};

export type VideoOutputDestination = {
  createFile: (filename: string) => Promise<VideoOutputFile>;
  kind: "directory" | "downloads" | "opfs-downloads";
};

export type PrepareVideoOutputDestinationOptions = {
  fileCount?: number;
};

/**
 * Chooses a streaming directory when the browser supports File System Access.
 * The picker is intentionally called before any other async export work so the
 * browser still considers it part of the user's click.
 */
export async function prepareVideoOutputDestination(
  options: PrepareVideoOutputDestinationOptions = {},
): Promise<VideoOutputDestination | null> {
  const pickerWindow = window as DirectoryPickerWindow;
  const fileCount = options.fileCount ?? 1;

  if (!Number.isInteger(fileCount) || fileCount <= 0) {
    throw new RangeError("fileCount must be a positive integer.");
  }

  if (typeof pickerWindow.showDirectoryPicker !== "function") {
    if (fileCount > 1) {
      throw createMultiFileDirectoryRequiredError();
    }

    return await createBestDownloadDestination();
  }

  try {
    const directory = await pickerWindow.showDirectoryPicker({
      id: "outcraft-video-exports",
      mode: "readwrite",
      startIn: "downloads",
    });

    return createDirectoryDestination(directory);
  } catch (error) {
    if (isPickerCancellation(error)) {
      return null;
    }

    if (fileCount > 1) {
      throw createMultiFileDirectoryRequiredError(error);
    }

    console.warn(
      "Direct-to-disk video export is unavailable; falling back to browser downloads.",
      error,
    );
    return await createBestDownloadDestination();
  }
}

function createDirectoryDestination(
  directory: FileSystemDirectoryHandle,
): VideoOutputDestination {
  return {
    kind: "directory",
    createFile: async (filename) => {
      const safeFilename = await getAvailableFilename(
        directory,
        sanitizeFilename(filename),
      );
      let fileHandle: FileSystemFileHandle;
      let writable: FileSystemWritableFileStream;

      try {
        fileHandle = await directory.getFileHandle(safeFilename, {
          create: true,
        });
        writable = await fileHandle.createWritable({
          keepExistingData: false,
        });
      } catch (error) {
        throw new Error(`Could not open "${safeFilename}" for writing.`, {
          cause: error,
        });
      }

      const { abort, target } = createStreamingTarget(writable);
      let isFinished = false;
      let completedFile: CompletedVideoOutputFile | null = null;

      return {
        target,
        finish: async () => {
          if (completedFile) {
            return completedFile;
          }

          const file = await fileHandle.getFile();

          if (file.size <= 0) {
            throw new Error(
              `The encoded file "${safeFilename}" is empty after finalization.`,
            );
          }

          isFinished = true;
          completedFile = {
            filename: safeFilename,
            sizeBytes: file.size,
          };
          return completedFile;
        },
        discard: async () => {
          if (isFinished) {
            return;
          }

          await abort();
          await removeEntryWithRetries(directory, safeFilename);
        },
      };
    },
  };
}

async function createBestDownloadDestination() {
  try {
    const root = await navigator.storage?.getDirectory();

    if (root) {
      await removeStaleOpfsExports(root);
      return createOpfsDownloadDestination(root);
    }
  } catch (error) {
    console.warn(
      "Origin-private streaming storage is unavailable; using an in-memory download.",
      error,
    );
  }

  return createDownloadDestination();
}

async function removeStaleOpfsExports(directory: FileSystemDirectoryHandle) {
  const staleBefore = Date.now() - staleOpfsFileAgeMs;

  for await (const [name, handle] of directory.entries()) {
    if (!name.startsWith(opfsTemporaryPrefix) || handle.kind !== "file") {
      continue;
    }

    try {
      const file = await handle.getFile();

      if (file.lastModified < staleBefore) {
        await directory.removeEntry(name);
      }
    } catch {
      // Cleanup is opportunistic and must never block a new export.
    }
  }
}

function createOpfsDownloadDestination(
  directory: FileSystemDirectoryHandle,
): VideoOutputDestination {
  return {
    kind: "opfs-downloads",
    createFile: async (filename) => {
      const safeFilename = sanitizeFilename(filename);
      const temporaryFilename = `${opfsTemporaryPrefix}${crypto.randomUUID()}`;
      const fileHandle = await directory.getFileHandle(temporaryFilename, {
        create: true,
      });
      const writable = await fileHandle.createWritable({
        keepExistingData: false,
      });
      const { abort, target } = createStreamingTarget(writable);
      let isFinished = false;
      let completedFile: CompletedVideoOutputFile | null = null;

      return {
        target,
        finish: async () => {
          if (completedFile) {
            return completedFile;
          }

          const file = await fileHandle.getFile();

          if (file.size <= 0) {
            throw new Error(
              `The encoded file "${safeFilename}" is empty after finalization.`,
            );
          }

          downloadBlob(file, safeFilename, () => {
            void directory.removeEntry(temporaryFilename).catch(() => undefined);
          });
          isFinished = true;
          completedFile = {
            filename: safeFilename,
            sizeBytes: file.size,
          };
          return completedFile;
        },
        discard: async () => {
          if (!isFinished) {
            await abort();
            await directory
              .removeEntry(temporaryFilename)
              .catch(() => undefined);
          }
        },
      };
    },
  };
}

function createStreamingTarget(writable: FileSystemWritableFileStream) {
  const adapter = new WritableStream<StreamTargetChunk>({
    write: (chunk) => writable.write(chunk),
    close: () => writable.close(),
    abort: (reason) => writable.abort(reason),
  });
  const target = new StreamTarget(adapter, {
    chunked: true,
    chunkSize: streamChunkSizeBytes,
  });

  return {
    target,
    abort: async () => {
      await writable.abort().catch(() => undefined);
    },
  };
}

async function getAvailableFilename(
  directory: FileSystemDirectoryHandle,
  requestedFilename: string,
) {
  const extensionIndex = requestedFilename.lastIndexOf(".");
  const stem =
    extensionIndex > 0
      ? requestedFilename.slice(0, extensionIndex)
      : requestedFilename;
  const extension =
    extensionIndex > 0 ? requestedFilename.slice(extensionIndex) : "";

  for (let suffix = 1; suffix <= 10_000; suffix += 1) {
    const candidate =
      suffix === 1 ? requestedFilename : `${stem}-${suffix}${extension}`;

    try {
      await directory.getFileHandle(candidate);
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") {
        return candidate;
      }

      // A directory with this name or another handle-type collision also means
      // the candidate is unavailable. Permission failures must surface.
      if (error instanceof DOMException && error.name === "TypeMismatchError") {
        continue;
      }

      throw error;
    }
  }

  throw new Error("Could not choose a unique video export filename.");
}

function createDownloadDestination(): VideoOutputDestination {
  return {
    kind: "downloads",
    createFile: async (filename) => {
      const target = new BufferTarget();
      let completedFile: CompletedVideoOutputFile | null = null;

      return {
        target,
        finish: async (mimeType) => {
          if (completedFile) {
            return completedFile;
          }

          const buffer = target.buffer;

          if (!buffer) {
            throw new Error("The encoded video buffer was not finalized.");
          }

          const blob = new Blob([buffer], { type: mimeType });
          target.buffer = null;
          downloadBlob(blob, sanitizeFilename(filename));
          completedFile = {
            filename: sanitizeFilename(filename),
            sizeBytes: blob.size,
          };
          return completedFile;
        },
        discard: async () => {
          target.buffer = null;
        },
      };
    },
  };
}

function downloadBlob(
  blob: Blob,
  filename: string,
  onRevoke?: () => void,
) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.download = filename;
  link.href = url;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
    onRevoke?.();
  }, downloadUrlLifetimeMs);
}

async function removeEntryWithRetries(
  directory: FileSystemDirectoryHandle,
  filename: string,
) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await directory.removeEntry(filename);
      return;
    } catch (error) {
      if (
        error instanceof DOMException &&
        error.name === "NotFoundError"
      ) {
        return;
      }

      if (attempt === 3) {
        console.warn(`Could not remove partial export "${filename}".`, error);
        return;
      }

      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 50 * (attempt + 1));
      });
    }
  }
}

function createMultiFileDirectoryRequiredError(cause?: unknown) {
  return new Error(
    "Multi-format export requires a writable folder. Use a browser that supports folder selection, allow folder access, or export one format at a time.",
    cause === undefined ? undefined : { cause },
  );
}

function sanitizeFilename(filename: string) {
  const safeFilename = filename
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[.\s]+$/g, "")
    .trim();

  return safeFilename || "outcraft-video";
}

function isPickerCancellation(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}
