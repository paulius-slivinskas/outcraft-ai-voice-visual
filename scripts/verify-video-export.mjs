import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";

const execFileAsync = promisify(execFile);
const commandArguments = new Set(process.argv.slice(2));
const formatArguments = [...commandArguments].filter((argument) =>
  argument.startsWith("--format="),
);
// The opt-in profile mirrors the reported failure: one seven-minute audio
// timeline encoded across four formats. --all-formats expands it to all five.
const enduranceMode =
  commandArguments.has("--endurance") ||
  process.env.VIDEO_EXPORT_ENDURANCE === "1";
const requestedAllFormats =
  commandArguments.has("--all-formats") ||
  process.env.VIDEO_EXPORT_ALL_FORMATS === "1";
const targetUrl = process.env.APP_URL ?? "http://127.0.0.1:5173/";
const artifactDir = fileURLToPath(new URL("../test-artifacts/", import.meta.url));
const videoFormat = (
  formatArguments[0]?.slice("--format=".length) ??
  process.env.VIDEO_EXPORT_FORMAT ??
  "webm"
).toLowerCase();
const withAudio =
  enduranceMode || process.env.VIDEO_EXPORT_WITH_AUDIO === "1";
const configuredDurationSeconds = process.env.VIDEO_EXPORT_DURATION_SECONDS;
const expectedDurationSeconds = enduranceMode
  ? 420
  : Number(configuredDurationSeconds ?? 15);
const expectedFrameRate = 30;
const expectedAudioChannelCount = 1;
const expectedAudioChannelLayout = "mono";
const ffmpegBin = process.env.FFMPEG_BIN ?? "ffmpeg";
const ffprobeBin = process.env.FFPROBE_BIN ?? "ffprobe";
const supportedDurationSeconds = new Set([15, 30, 60, 120, 240, 420]);
const videoExportTargets = [
  { height: 1080, label: "1:1", slug: "1x1", width: 1080 },
  { height: 1440, label: "3:4", slug: "3x4", width: 1080 },
  { height: 1080, label: "4:3", slug: "4x3", width: 1440 },
  { height: 1080, label: "16:9", slug: "16x9", width: 1920 },
  { height: 1920, label: "9:16", slug: "9x16", width: 1080 },
];
const enduranceTargetCount = Number(
  process.env.VIDEO_EXPORT_ENDURANCE_TARGET_COUNT ??
    (requestedAllFormats ? videoExportTargets.length : 4),
);
const expectedTargets = enduranceMode
  ? videoExportTargets.slice(0, enduranceTargetCount)
  : requestedAllFormats
    ? videoExportTargets
    : videoExportTargets.slice(0, 1);
const allFormats = expectedTargets.length === videoExportTargets.length;
const multiFormat = expectedTargets.length > 1;
const useDirectDirectory = multiFormat;
const verifierDirectoryName = `outcraft-video-verifier-${process.pid}-${Date.now()}`;
const exportTimeoutMs = Number(
  process.env.VIDEO_EXPORT_TIMEOUT_MS ??
    (enduranceMode || expectedDurationSeconds === 420
      ? 7_200_000
      : multiFormat
        ? 900_000
        : 180_000),
);
const exportedFiles = [];
const configurationErrors = [];
const unknownArguments = [...commandArguments].filter(
  (argument) =>
    !["--all-formats", "--endurance"].includes(argument) &&
    !argument.startsWith("--format="),
);

if (formatArguments.length > 1) {
  configurationErrors.push(
    "only one --format=mp4 or --format=webm argument is allowed",
  );
}
if (unknownArguments.length > 0) {
  configurationErrors.push(
    `unknown argument${unknownArguments.length === 1 ? "" : "s"}: ${unknownArguments.join(", ")}`,
  );
}
if (!["mp4", "webm"].includes(videoFormat)) {
  configurationErrors.push(
    "VIDEO_EXPORT_FORMAT/--format must be webm or mp4",
  );
}
if (!supportedDurationSeconds.has(expectedDurationSeconds)) {
  configurationErrors.push(
    "VIDEO_EXPORT_DURATION_SECONDS must be 15, 30, 60, 120, 240, or 420",
  );
}
if (expectedDurationSeconds === 420 && !withAudio) {
  configurationErrors.push(
    "a 420-second export requires VIDEO_EXPORT_WITH_AUDIO=1 or --endurance because the UI has no 420-second silent preset",
  );
}
if (
  enduranceMode &&
  configuredDurationSeconds !== undefined &&
  Number(configuredDurationSeconds) !== 420
) {
  configurationErrors.push(
    "--endurance is fixed at 420 seconds; remove VIDEO_EXPORT_DURATION_SECONDS or set it to 420",
  );
}
if (
  enduranceMode &&
  (!Number.isInteger(enduranceTargetCount) ||
    enduranceTargetCount < 4 ||
    enduranceTargetCount > videoExportTargets.length)
) {
  configurationErrors.push(
    `VIDEO_EXPORT_ENDURANCE_TARGET_COUNT must be 4 or ${videoExportTargets.length}`,
  );
}
if (!Number.isFinite(exportTimeoutMs) || exportTimeoutMs <= 0) {
  configurationErrors.push("VIDEO_EXPORT_TIMEOUT_MS must be positive");
}

if (configurationErrors.length > 0) {
  throw new Error(
    `Invalid video verifier configuration:\n- ${configurationErrors.join("\n- ")}`,
  );
}

await mkdir(artifactDir, { recursive: true });

const browser = await chromium.launch();
const pageErrors = [];
let rejectOnBrowserError;
const browserFailure = new Promise((_, reject) => {
  rejectOnBrowserError = reject;
});
let exportStarted = false;

try {
  const context = await browser.newContext({
    acceptDownloads: true,
    deviceScaleFactor: 1,
    viewport: { height: 900, width: 1440 },
  });
  const page = await context.newPage();

  page.on("console", (message) => {
    if (message.type() === "error") {
      const browserError = `console: ${message.text()}`;
      pageErrors.push(browserError);

      if (exportStarted) {
        rejectOnBrowserError(new Error(browserError));
      }
    }
  });
  page.on("pageerror", (error) => {
    const browserError = `pageerror: ${error.message}`;
    pageErrors.push(browserError);

    if (exportStarted) {
      rejectOnBrowserError(new Error(browserError));
    }
  });

  if (useDirectDirectory) {
    await page.addInitScript(({ directoryName }) => {
      Object.defineProperty(globalThis, "showDirectoryPicker", {
        configurable: true,
        value: async () => {
          const root = await navigator.storage.getDirectory();
          return await root.getDirectoryHandle(directoryName, {
            create: true,
          });
        },
      });
    }, { directoryName: verifierDirectoryName });
  } else {
    await page.addInitScript(() => {
      for (const pickerName of [
        "showDirectoryPicker",
        "showOpenFilePicker",
        "showSaveFilePicker",
      ]) {
        try {
          delete globalThis[pickerName];
        } catch {
          try {
            Object.defineProperty(globalThis, pickerName, {
              configurable: true,
              value: undefined,
            });
          } catch {
            // The test still exercises the ordinary download path where supported.
          }
        }
      }
    });
  }

  await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("canvas.shader-stage");
  await page.waitForTimeout(500);

  if (useDirectDirectory) {
    await page.evaluate(async (directoryName) => {
      const root = await navigator.storage.getDirectory();

      await root
        .removeEntry(directoryName, { recursive: true })
        .catch(() => undefined);
      await root.getDirectoryHandle(directoryName, { create: true });
    }, verifierDirectoryName);
  }

  const formatToggles = page.locator(".format-toggle");
  const toggleCount = await formatToggles.count();

  if (toggleCount !== videoExportTargets.length) {
    throw new Error(
      `Expected ${videoExportTargets.length} video format toggles, found ${toggleCount}.`,
    );
  }

  for (const toggle of await formatToggles.all()) {
    const toggleText = (await toggle.innerText()).replace(/\s+/g, " ").trim();
    const target = videoExportTargets.find(({ label }) =>
      toggleText.includes(label),
    );

    if (!target) {
      throw new Error(`Could not identify video format toggle "${toggleText}".`);
    }

    const shouldBeSelected = expectedTargets.some(
      ({ slug }) => slug === target.slug,
    );
    const isSelected = (await toggle.getAttribute("aria-pressed")) === "true";

    if (isSelected !== shouldBeSelected) {
      await toggle.click();
    }
  }

  for (const target of videoExportTargets) {
    const toggle = formatToggles.filter({ hasText: target.label }).first();
    const isSelected = (await toggle.getAttribute("aria-pressed")) === "true";
    const shouldBeSelected = expectedTargets.some(
      ({ slug }) => slug === target.slug,
    );

    if (isSelected !== shouldBeSelected) {
      throw new Error(
        `Video format selection mismatch for ${target.label}: expected ${shouldBeSelected ? "selected" : "unselected"}.`,
      );
    }
  }

  const exportButton = page.getByRole("button", {
    name: /^export video(?:\s|$)/i,
  });

  if (withAudio) {
    const audioFileName = `verify-${expectedDurationSeconds}s.wav`;
    const audioInput = page.locator("input[type='file'][accept*='audio']").first();

    await audioInput.setInputFiles({
      buffer: createDeterministicWav(expectedDurationSeconds),
      mimeType: "audio/wav",
      name: audioFileName,
    });
    await page.getByText(audioFileName, { exact: true }).waitFor();
    await page.waitForFunction(
      ({ durationLabel }) =>
        Array.from(document.querySelectorAll("button")).some(
          (button) =>
            button.textContent?.includes("Export Video") &&
            button.textContent.includes(`Audio · ${durationLabel}`),
        ),
      { durationLabel: formatMediaDurationLabel(expectedDurationSeconds) },
    );
  } else {
    for (const audioButtonName of [
      /disable file audio/i,
      /disable microphone audio/i,
    ]) {
      const audioButton = page.getByRole("button", { name: audioButtonName });

      if (
        (await audioButton.count()) > 0 &&
        (await audioButton.first().isVisible())
      ) {
        await audioButton.first().click();
      }
    }
  }

  const exportButtonText = (await exportButton.innerText()) ?? "";

  const hasAudioStatus =
    /\baudio\b/i.test(exportButtonText) && !/no audio/i.test(exportButtonText);

  if (withAudio ? !hasAudioStatus : !/no audio/i.test(exportButtonText)) {
    throw new Error(
      `Video export audio mode mismatch: expected ${withAudio ? "audio" : "no audio"}, got "${exportButtonText}".`,
    );
  }

  await page.getByRole("button", { name: /video export settings/i }).click();

  const formatOption = page.getByRole("menuitemcheckbox", {
    name: new RegExp(`^${videoFormat}$`, "i"),
  });
  const durationOption = page.getByRole("menuitemcheckbox", {
    name: new RegExp(
      `^${escapeRegExp(formatVideoDurationLabel(expectedDurationSeconds))}$`,
      "i",
    ),
  });
  const frameRateOption = page.getByRole("menuitemcheckbox", {
    name: new RegExp(`^${expectedFrameRate} fps$`, "i"),
  });
  const bitrateOption = page.getByRole("menuitemcheckbox", { name: /^low$/i });
  const settingsOptions = [formatOption, frameRateOption, bitrateOption];

  if (withAudio) {
    await page
      .getByText(
        `Audio duration · ${formatMediaDurationLabel(expectedDurationSeconds)}`,
        { exact: true },
      )
      .waitFor();
  } else {
    settingsOptions.push(durationOption);
  }

  for (const option of settingsOptions) {
    await option.waitFor();

    if ((await option.getAttribute("aria-checked")) !== "true") {
      await option.click();
    }
  }

  await page.keyboard.press("Escape");

  let rejectOnDialog;
  const dialogFailure = new Promise((_, reject) => {
    rejectOnDialog = reject;
  });

  page.on("dialog", async (dialog) => {
    rejectOnDialog(
      new Error(`Video export opened a browser dialog: ${dialog.message()}`),
    );
    await dialog.dismiss();
  });

  const downloadCollector = collectDownloads(
    page,
    expectedTargets.length,
    exportTimeoutMs,
  );
  const progressMonitor = monitorExportProgress(page);
  const downloadOrFailure = Promise.race([
    downloadCollector.promise,
    dialogFailure,
    browserFailure,
    progressMonitor.promise,
  ]);
  exportStarted = true;
  let downloads;

  try {
    await page.evaluate(() => {
      window.requestAnimationFrame = () => 0;
    });
    await exportButton.evaluate((button) => button.click());

    if (useDirectDirectory) {
      const directoryFiles = await Promise.race([
        waitForDirectDirectoryExport(
          page,
          verifierDirectoryName,
          expectedTargets.length,
          exportTimeoutMs,
        ),
        dialogFailure,
        browserFailure,
        progressMonitor.promise,
      ]);

      console.log(
        `[video-verify] direct directory finalized ${directoryFiles.length}/${expectedTargets.length} files`,
      );
      await triggerDirectoryFileDownloads(
        page,
        verifierDirectoryName,
      );
    }

    downloads = await downloadOrFailure;
  } finally {
    progressMonitor.dispose();
    downloadCollector.dispose();
  }

  const seenTargetSlugs = new Set();
  const seenFilenames = new Set();

  for (const download of downloads) {
    const downloadFailure = await download.failure();

    if (downloadFailure) {
      throw new Error(`Browser download failed: ${downloadFailure}`);
    }

    const suggestedFilename = basename(download.suggestedFilename());

    if (!suggestedFilename.endsWith(`.${videoFormat}`)) {
      throw new Error(
        `Expected a ${videoFormat.toUpperCase()} export, got ${suggestedFilename}`,
      );
    }

    if (seenFilenames.has(suggestedFilename)) {
      throw new Error(`Duplicate export filename: ${suggestedFilename}`);
    }

    const target = getTargetFromFilename(suggestedFilename);

    if (
      !target ||
      !expectedTargets.some(({ slug }) => slug === target.slug)
    ) {
      throw new Error(
        `Export filename does not identify an expected format: ${suggestedFilename}`,
      );
    }

    if (seenTargetSlugs.has(target.slug)) {
      throw new Error(
        `Received more than one export for the ${target.label} format.`,
      );
    }

    const outputPath = multiFormat
      ? join(
          artifactDir,
          `video-export-${enduranceMode ? "endurance" : "multi"}-${target.slug}-${expectedDurationSeconds}s${withAudio ? "-audio" : ""}.${videoFormat}`,
        )
      : join(
          artifactDir,
          `video-export-smoke${withAudio ? "-audio" : ""}.${videoFormat}`,
        );

    await download.saveAs(outputPath);
    seenFilenames.add(suggestedFilename);
    seenTargetSlugs.add(target.slug);
    exportedFiles.push({ outputPath, suggestedFilename, target });
  }

  const missingTargets = expectedTargets.filter(
    ({ slug }) => !seenTargetSlugs.has(slug),
  );

  if (missingTargets.length > 0) {
    throw new Error(
      `Missing video exports for: ${missingTargets.map(({ label }) => label).join(", ")}.`,
    );
  }

  if (withAudio) {
    await page
      .getByRole("button", { name: /enable file audio/i })
      .waitFor({ timeout: 10_000 });
  }

  if (useDirectDirectory) {
    await page.evaluate(async (directoryName) => {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(directoryName, { recursive: true });
    }, verifierDirectoryName);
  }

  await context.close();
} finally {
  await browser.close();
}

if (pageErrors.length > 0) {
  throw new Error(`Browser errors during export:\n${pageErrors.join("\n")}`);
}

const exportSummaries = [];

for (const exportedFile of exportedFiles) {
  exportSummaries.push(await verifyExport(exportedFile));
}

console.log(
  JSON.stringify({
    allFormats,
    enduranceMode,
    exports: exportSummaries,
    format: videoFormat,
    requestedDurationSeconds: expectedDurationSeconds,
    targetCount: expectedTargets.length,
    withAudio,
  }),
);

async function verifyExport({ outputPath, suggestedFilename, target }) {
  const outputStats = await stat(outputPath);

  if (outputStats.size < 50_000) {
    throw new Error(
      `${suggestedFilename} is unexpectedly small: ${outputStats.size} bytes`,
    );
  }

  const probe = await probeVideo(outputPath);
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const videoStream = streams.find((stream) => stream.codec_type === "video");
  const audioStreams = streams.filter(
    (stream) => stream.codec_type === "audio",
  );

  if (!videoStream) {
    throw new Error(
      `ffprobe did not find a video stream in ${suggestedFilename}.`,
    );
  }

  if (withAudio && audioStreams.length === 0) {
    throw new Error(
      `ffprobe did not find an audio stream in ${suggestedFilename}.`,
    );
  }

  if (withAudio && audioStreams.length !== 1) {
    throw new Error(
      `${suggestedFilename} must contain exactly one audio stream, found ${audioStreams.length}.`,
    );
  }

  if (!withAudio && audioStreams.length > 0) {
    throw new Error(
      `${suggestedFilename} unexpectedly contains an audio stream.`,
    );
  }

  const audioStream = audioStreams[0] ?? null;
  const audioChannelCount = audioStream
    ? Number(audioStream.channels)
    : null;
  const audioChannelLayout =
    typeof audioStream?.channel_layout === "string"
      ? audioStream.channel_layout.toLowerCase()
      : null;

  if (
    withAudio &&
    (
      audioChannelCount !== expectedAudioChannelCount ||
      audioChannelLayout !== expectedAudioChannelLayout
    )
  ) {
    throw new Error(
      `${suggestedFilename} audio is not true mono: expected channels=${expectedAudioChannelCount} and channel_layout=${expectedAudioChannelLayout}, got channels=${audioChannelCount} and channel_layout=${audioChannelLayout ?? "missing"}.`,
    );
  }

  const actualWidth = Number(videoStream.width);
  const actualHeight = Number(videoStream.height);

  if (actualWidth !== target.width || actualHeight !== target.height) {
    throw new Error(
      `${suggestedFilename} dimensions mismatch: expected ${target.width}x${target.height} for ${target.label}, got ${actualWidth}x${actualHeight}.`,
    );
  }

  const durationSeconds = getProbeDurationSeconds(probe, videoStream);
  const durationToleranceSeconds = Math.max(
    0.25,
    2 / expectedFrameRate,
  );

  if (
    !Number.isFinite(durationSeconds) ||
    Math.abs(durationSeconds - expectedDurationSeconds) >
      durationToleranceSeconds
  ) {
    throw new Error(
      `${suggestedFilename} duration mismatch: expected about ${expectedDurationSeconds}s, got ${durationSeconds}s`,
    );
  }

  const actualFrameRate = getProbeFrameRate(videoStream);
  const actualFrameCount = getProbeFrameCount(videoStream);
  const actualVideoPacketCount = getProbePacketCount(videoStream);
  const expectedFrameCount = Math.ceil(
    expectedDurationSeconds * expectedFrameRate - 1e-9,
  );

  if (
    !Number.isFinite(actualFrameRate) ||
    Math.abs(actualFrameRate - expectedFrameRate) > 0.01
  ) {
    throw new Error(
      `${suggestedFilename} frame rate mismatch: expected ${expectedFrameRate} fps, got ${actualFrameRate}.`,
    );
  }

  if (
    !Number.isSafeInteger(actualFrameCount) ||
    actualFrameCount !== expectedFrameCount
  ) {
    throw new Error(
      `${suggestedFilename} decoded frame count mismatch: expected ${expectedFrameCount}, got ${actualFrameCount}.`,
    );
  }

  if (
    !Number.isSafeInteger(actualVideoPacketCount) ||
    actualVideoPacketCount !== expectedFrameCount
  ) {
    throw new Error(
      `${suggestedFilename} video packet count mismatch: expected ${expectedFrameCount}, got ${actualVideoPacketCount}.`,
    );
  }

  let audioPacketStats = null;

  if (withAudio) {
    audioPacketStats = await probeAudioPacketStats(outputPath);

    if (
      audioPacketStats.packetCount < 2 ||
      !Number.isFinite(audioPacketStats.durationSeconds) ||
      Math.abs(audioPacketStats.durationSeconds - expectedDurationSeconds) >
        durationToleranceSeconds
    ) {
      throw new Error(
        `${suggestedFilename} audio packet duration mismatch: expected about ${expectedDurationSeconds}s, got ${audioPacketStats.durationSeconds}s across ${audioPacketStats.packetCount} packets.`,
      );
    }
  }

  const frameHashes = {};

  for (const sample of getMotionSampleWindows(durationSeconds)) {
    const hashes = await collectFrameHashes(
      outputPath,
      sample.startSeconds,
      sample.durationSeconds,
    );
    assertMovingFrames(`${suggestedFilename} ${sample.name}`, hashes);
    frameHashes[sample.name] = hashes;
  }

  if (frameHashes.beginning[0] === frameHashes.ending.at(-1)) {
    throw new Error(
      `${suggestedFilename} has the same frame at the beginning and end.`,
    );
  }

  return {
    audioChannelLayout,
    audioChannels: audioChannelCount,
    audioCodec: audioStreams[0]?.codec_name ?? null,
    audioDurationSeconds: audioPacketStats?.durationSeconds ?? null,
    codec: videoStream.codec_name,
    durationSeconds,
    file: outputPath,
    frameCount: actualFrameCount,
    frameRate: actualFrameRate,
    videoPacketCount: actualVideoPacketCount,
    frameSamples: {
      beginning: new Set(frameHashes.beginning).size,
      middle: new Set(frameHashes.middle).size,
      ending: new Set(frameHashes.ending).size,
    },
    height: actualHeight,
    label: target.label,
    sizeBytes: outputStats.size,
    width: actualWidth,
  };
}

function collectDownloads(page, expectedCount, timeoutMs) {
  const downloads = [];
  let timeout;
  let resolveDownloads;
  let rejectDownloads;
  const promise = new Promise((resolve, reject) => {
    resolveDownloads = resolve;
    rejectDownloads = reject;
  });
  const onDownload = (download) => {
    downloads.push(download);
    console.log(
      `[video-verify] download ${downloads.length}/${expectedCount}: ${download.suggestedFilename()}`,
    );

    if (downloads.length === expectedCount) {
      resolveDownloads([...downloads]);
    }
  };

  page.on("download", onDownload);
  timeout = setTimeout(() => {
    rejectDownloads(
      new Error(
        `Timed out after ${timeoutMs}ms waiting for ${expectedCount} video download${expectedCount === 1 ? "" : "s"}; received ${downloads.length}.`,
      ),
    );
  }, timeoutMs);

  return {
    dispose() {
      clearTimeout(timeout);
      page.off("download", onDownload);
    },
    promise,
  };
}

async function waitForDirectDirectoryExport(
  page,
  directoryName,
  expectedCount,
  timeoutMs,
) {
  const exportCover = page.locator(".recording-cover");

  await exportCover.waitFor({ state: "visible", timeout: 10_000 });
  await exportCover.waitFor({ state: "detached", timeout: timeoutMs });
  const completionNotice = page
    .getByRole("status")
    .filter({ hasText: /^Export complete:/ })
    .first();
  await completionNotice.waitFor({ timeout: 10_000 });
  const completionText = (await completionNotice.textContent()) ?? "";

  if (!completionText.includes(`${expectedCount}/${expectedCount}`)) {
    throw new Error(
      `Direct directory completion summary is invalid: ${completionText}`,
    );
  }

  const files = await page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(name);
    const entries = [];

    for await (const [filename, handle] of directory.entries()) {
      if (handle.kind !== "file") {
        continue;
      }

      const file = await handle.getFile();
      entries.push({ filename, sizeBytes: file.size });
    }

    return entries.sort((left, right) =>
      left.filename.localeCompare(right.filename),
    );
  }, directoryName);

  if (files.length !== expectedCount) {
    throw new Error(
      `Direct directory export produced ${files.length}/${expectedCount} files: ${JSON.stringify(files)}`,
    );
  }

  const emptyFiles = files.filter(({ sizeBytes }) => sizeBytes <= 0);

  if (emptyFiles.length > 0) {
    throw new Error(
      `Direct directory export produced empty files: ${emptyFiles.map(({ filename }) => filename).join(", ")}`,
    );
  }

  const seenTargets = new Set();

  for (const { filename } of files) {
    const target = getTargetFromFilename(filename);

    if (!target) {
      throw new Error(
        `Direct directory filename does not identify a target: ${filename}`,
      );
    }

    seenTargets.add(target.slug);
  }

  const missingTargets = expectedTargets.filter(
    ({ slug }) => !seenTargets.has(slug),
  );

  if (missingTargets.length > 0) {
    throw new Error(
      `Direct directory export is missing: ${missingTargets.map(({ label }) => label).join(", ")}`,
    );
  }

  return files;
}

async function triggerDirectoryFileDownloads(page, directoryName) {
  await page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(name);
    const files = [];

    for await (const [filename, handle] of directory.entries()) {
      if (handle.kind === "file") {
        files.push({
          file: await handle.getFile(),
          filename,
        });
      }
    }

    files.sort((left, right) =>
      left.filename.localeCompare(right.filename),
    );

    for (const { file, filename } of files) {
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.download = filename;
      link.href = url;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  }, directoryName);
}

function monitorExportProgress(page) {
  const startedAt = Date.now();
  let isDisposed = false;
  let isSampling = false;
  let lastLabel = "";
  let lastPercent = -1;
  let interval;
  let rejectFailure;
  const promise = new Promise((_, reject) => {
    rejectFailure = reject;
  });

  const sample = async () => {
    if (isDisposed || isSampling) {
      return;
    }

    isSampling = true;

    try {
      const status = page.locator("[role='status'][aria-label^='Exporting ']").first();
      const label = (await status.getAttribute("aria-label")) ?? "";
      const percentMatch = /^Exporting\s+(\d+)%$/.exec(label);
      const percent = percentMatch ? Number(percentMatch[1]) : Number.NaN;

      if (Number.isFinite(percent) && percent < lastPercent) {
        rejectFailure(
          new Error(
            `Export progress regressed from ${lastPercent}% to ${percent}%.`,
          ),
        );
        isDisposed = true;
        clearInterval(interval);
        return;
      }

      if (Number.isFinite(percent)) {
        lastPercent = percent;
      }

      if (label && label !== lastLabel) {
        const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
        console.log(`[video-verify +${elapsedSeconds}s] ${label}`);
        lastLabel = label;
      }
    } catch {
      // The primary browser/page listeners report actionable failures.
    } finally {
      isSampling = false;
    }
  };

  void sample();
  interval = setInterval(() => {
    void sample();
  }, 10_000);

  return {
    dispose() {
      isDisposed = true;
      clearInterval(interval);
    },
    promise,
  };
}

function getTargetFromFilename(filename) {
  const normalizedFilename = filename.toLowerCase();

  return videoExportTargets.find(({ slug }) => {
    const escapedSlug = escapeRegExp(slug);
    const escapedFormat = escapeRegExp(videoFormat);

    return (
      new RegExp(
        `-${expectedDurationSeconds}s(?:-loop)?-${escapedSlug}\\.${escapedFormat}$`,
      ).test(normalizedFilename) ||
      new RegExp(
        `-${escapedSlug}-${expectedDurationSeconds}s(?:-loop)?\\.${escapedFormat}$`,
      ).test(normalizedFilename)
    );
  });
}

async function probeVideo(path) {
  const { stdout } = await runMediaTool(ffprobeBin, [
    "-v",
    "error",
    "-count_frames",
    "-count_packets",
    "-show_format",
    "-show_streams",
    "-of",
    "json",
    path,
  ]);

  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`ffprobe returned invalid JSON:\n${stdout}`);
  }
}

function getProbeDurationSeconds(probe, videoStream) {
  const durations = [
    Number(probe.format?.duration),
    Number(videoStream.duration),
  ].filter(Number.isFinite);

  return durations.length > 0 ? Math.max(...durations) : Number.NaN;
}

function getProbeFrameCount(videoStream) {
  const candidates = [
    Number(videoStream.nb_read_frames),
    Number(videoStream.nb_frames),
  ].filter(Number.isSafeInteger);

  return candidates[0] ?? Number.NaN;
}

function getProbePacketCount(videoStream) {
  const packetCount = Number(videoStream.nb_read_packets);

  return Number.isSafeInteger(packetCount) ? packetCount : Number.NaN;
}

function getProbeFrameRate(videoStream) {
  const candidates = [
    parseFrameRate(videoStream.avg_frame_rate),
    parseFrameRate(videoStream.r_frame_rate),
  ].filter(Number.isFinite);

  return candidates[0] ?? Number.NaN;
}

function parseFrameRate(value) {
  if (typeof value !== "string") {
    return Number.NaN;
  }

  const [numerator, denominator = "1"] = value.split("/");
  const numericNumerator = Number(numerator);
  const numericDenominator = Number(denominator);

  return Number.isFinite(numericNumerator) &&
    Number.isFinite(numericDenominator) &&
    numericDenominator !== 0
    ? numericNumerator / numericDenominator
    : Number.NaN;
}

async function probeAudioPacketStats(path) {
  const { stdout } = await runMediaTool(ffprobeBin, [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "packet=pts_time,duration_time",
    "-of",
    "json",
    path,
  ]);
  let packetProbe;

  try {
    packetProbe = JSON.parse(stdout);
  } catch {
    throw new Error(`ffprobe returned invalid audio packet JSON:\n${stdout}`);
  }

  const packets = Array.isArray(packetProbe.packets) ? packetProbe.packets : [];
  const packetEnds = packets
    .map((packet) => {
      const presentationTime = Number(packet.pts_time);
      const packetDuration = Number(packet.duration_time);

      return Number.isFinite(presentationTime)
        ? presentationTime + (Number.isFinite(packetDuration) ? packetDuration : 0)
        : Number.NaN;
    })
    .filter(Number.isFinite);

  return {
    durationSeconds:
      packetEnds.length > 0 ? Math.max(...packetEnds) : Number.NaN,
    packetCount: packets.length,
  };
}

function getMotionSampleWindows(durationSeconds) {
  const sampleDurationSeconds = 2;

  return [
    {
      durationSeconds: sampleDurationSeconds,
      name: "beginning",
      startSeconds: Math.min(
        1,
        Math.max(0, durationSeconds - sampleDurationSeconds),
      ),
    },
    {
      durationSeconds: sampleDurationSeconds,
      name: "middle",
      startSeconds: Math.max(
        0,
        durationSeconds / 2 - sampleDurationSeconds / 2,
      ),
    },
    {
      durationSeconds: sampleDurationSeconds,
      name: "ending",
      startSeconds: Math.max(
        0,
        durationSeconds - sampleDurationSeconds - 1,
      ),
    },
  ];
}

async function collectFrameHashes(path, startSeconds, durationSeconds) {
  const { stdout } = await runMediaTool(ffmpegBin, [
    "-v",
    "error",
    "-ss",
    startSeconds.toFixed(3),
    "-i",
    path,
    "-t",
    durationSeconds.toFixed(3),
    "-vf",
    "fps=4,scale=64:64:flags=area",
    "-an",
    "-f",
    "framemd5",
    "-",
  ]);

  return stdout
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(",").at(-1)?.trim())
    .filter(Boolean);
}

function assertMovingFrames(sampleName, hashes) {
  if (hashes.length < 2) {
    throw new Error(
      `Could not decode enough ${sampleName} frames: ${hashes.length}`,
    );
  }

  if (new Set(hashes).size < 2) {
    throw new Error(`The video is frozen in the ${sampleName} sample.`);
  }
}

function createDeterministicWav(durationSeconds, sampleRate = 16_000) {
  // Deliberately feed a stereo source into the exporter. This makes the
  // ffprobe mono assertion exercise the production downmix instead of passing
  // trivially because the verifier input was already mono.
  const channelCount = 2;
  const bytesPerSample = 2;
  const sampleCount = Math.round(durationSeconds * sampleRate);
  const dataSize = sampleCount * channelCount * bytesPerSample;
  const wav = Buffer.alloc(44 + dataSize);

  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channelCount, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channelCount * bytesPerSample, 28);
  wav.writeUInt16LE(channelCount * bytesPerSample, 32);
  wav.writeUInt16LE(bytesPerSample * 8, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataSize, 40);

  for (let index = 0; index < sampleCount; index += 1) {
    const time = index / sampleRate;
    const leftSample =
      Math.sin(2 * Math.PI * 440 * time) * 0.18 +
      Math.sin(2 * Math.PI * 660 * time) * 0.06 +
      // Exercise the voice-focused waveform presentation range as well as the
      // full-spectrum shader bands. Descending harmonics form a visible centre
      // peak instead of allowing an audio export with an untested empty overlay.
      Math.sin(2 * Math.PI * 1_200 * time) * 0.12 +
      Math.sin(2 * Math.PI * 2_400 * time) * 0.06 +
      Math.sin(2 * Math.PI * 4_800 * time) * 0.025;
    const rightSample =
      Math.sin(2 * Math.PI * 330 * time + 0.25) * 0.14 +
      Math.sin(2 * Math.PI * 880 * time) * 0.08 +
      Math.sin(2 * Math.PI * 1_600 * time) * 0.1 +
      Math.sin(2 * Math.PI * 3_200 * time) * 0.04;
    const channelSamples = [leftSample, rightSample];

    for (
      let channelIndex = 0;
      channelIndex < channelCount;
      channelIndex += 1
    ) {
      const pcmValue = Math.round(
        Math.max(-1, Math.min(1, channelSamples[channelIndex] ?? 0)) *
          0x7fff,
      );
      const sampleOffset =
        44 +
        (index * channelCount + channelIndex) * bytesPerSample;

      wav.writeInt16LE(pcmValue, sampleOffset);
    }
  }

  return wav;
}

function formatVideoDurationLabel(durationSeconds) {
  return durationSeconds <= 60
    ? `${durationSeconds} seconds`
    : `${durationSeconds / 60} minutes`;
}

function formatMediaDurationLabel(durationSeconds) {
  const minutes = Math.floor(durationSeconds / 60);
  const seconds = durationSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runMediaTool(executable, args) {
  try {
    return await execFileAsync(executable, args, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `${executable} is required for video export verification but was not found.`,
      );
    }

    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    throw new Error(
      `${executable} failed${stderr ? `:\n${stderr.trim()}` : "."}`,
    );
  }
}
