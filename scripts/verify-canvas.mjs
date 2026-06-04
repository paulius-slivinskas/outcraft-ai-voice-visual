import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const targetUrl = process.env.APP_URL ?? "http://127.0.0.1:5173/";
const artifactDir = fileURLToPath(new URL("../test-artifacts/", import.meta.url));
const defaultGalleryState = {
  items: [],
  sections: [{ id: "favorites", isOpen: true, name: "Favorites" }],
};
const viewports = [
  { height: 900, name: "desktop", width: 1440 },
  { height: 844, name: "mobile", width: 390 },
];
const ratios = [
  { label: "1:1", value: 1 },
  { label: "2:3", value: 2 / 3 },
  { label: "3:2", value: 3 / 2 },
  { label: "3:4", value: 3 / 4 },
  { label: "4:3", value: 4 / 3 },
  { label: "9:16", value: 9 / 16 },
  { label: "16:9", value: 16 / 9 },
];

await mkdir(artifactDir, { recursive: true });

const originalGalleryState = await readRemoteGalleryState(targetUrl);
await writeRemoteGalleryState(targetUrl, defaultGalleryState);

const browser = await chromium.launch();

try {
  for (const viewport of viewports) {
    const page = await browser.newPage({
      deviceScaleFactor: 1,
      viewport: { height: viewport.height, width: viewport.width },
    });

    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("canvas.shader-stage");
    await page.waitForTimeout(500);

    const stats = await evaluateWithRetry(page, () => {
      const canvas = document.querySelector("canvas.shader-stage");
      const frame = document.querySelector(".format-frame");

      if (!(canvas instanceof HTMLCanvasElement) || !(frame instanceof HTMLElement)) {
        return { ready: false };
      }

      const frameRect = frame.getBoundingClientRect();

      const sampleCanvas = document.createElement("canvas");
      sampleCanvas.width = 96;
      sampleCanvas.height = 96;

      const context = sampleCanvas.getContext("2d", {
        willReadFrequently: true,
      });

      if (!context) {
        return { ready: false };
      }

      context.drawImage(canvas, 0, 0, sampleCanvas.width, sampleCanvas.height);

      const data = context.getImageData(
        0,
        0,
        sampleCanvas.width,
        sampleCanvas.height,
      ).data;
      const colors = new Set();
      let brightPixels = 0;
      let luminanceSum = 0;
      let luminanceSquaredSum = 0;

      for (let index = 0; index < data.length; index += 4) {
        const red = data[index] / 255;
        const green = data[index + 1] / 255;
        const blue = data[index + 2] / 255;
        const alpha = data[index + 3] / 255;
        const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;

        if (alpha > 0.98 && luminance > 0.035) {
          brightPixels += 1;
        }

        luminanceSum += luminance;
        luminanceSquaredSum += luminance * luminance;
        colors.add(
          `${Math.round(red * 31)}-${Math.round(green * 31)}-${Math.round(
            blue * 31,
          )}`,
        );
      }

      const pixelCount = data.length / 4;
      const luminanceMean = luminanceSum / pixelCount;
      const variance = luminanceSquaredSum / pixelCount - luminanceMean ** 2;

      return {
        brightPixels,
        canvasHeight: canvas.height,
        canvasWidth: canvas.width,
        frameHeight: frameRect.height,
        frameRatio: frameRect.width / frameRect.height,
        frameWidth: frameRect.width,
        ready: true,
        uniqueColors: colors.size,
        variance,
      };
    });

    await page.screenshot({
      path: join(artifactDir, `blob-${viewport.name}.png`),
    });

    const grainSlider = page.getByRole("slider", { name: /^grain$/i });
    const grainValue = Number(await grainSlider.getAttribute("aria-valuenow"));
    await page.getByRole("button", { name: /composition/i }).click();
    await page.waitForTimeout(50);

    const randomizedGrainValue = Number(await grainSlider.getAttribute("aria-valuenow"));

    if (Math.abs(randomizedGrainValue - grainValue) > 0.0005) {
      throw new Error(`${viewport.name} composition randomizer changed grain`);
    }

    await page.getByRole("button", { name: /pause/i }).click();
    await page.getByRole("button", { name: /play/i }).waitFor();
    const pausedFrame = await getCanvasDataUrl(page);
    await page.waitForTimeout(250);
    const laterPausedFrame = await getCanvasDataUrl(page);

    if (pausedFrame !== laterPausedFrame) {
      throw new Error(`${viewport.name} pause did not freeze the canvas frame`);
    }

    const frameScrubber = page.locator("[data-frame-scrubber]");
    const pausedSliderValue = await frameScrubber.getAttribute("data-frame-offset");

    if (pausedSliderValue !== "0") {
      throw new Error(`${viewport.name} frame scrubber did not pause at center`);
    }

    const scrubberBox = await frameScrubber.boundingBox();

    if (!scrubberBox) {
      throw new Error(`${viewport.name} frame scrubber was not visible`);
    }

    const scrubberCenterX = scrubberBox.x + scrubberBox.width / 2;
    const scrubberCenterY = scrubberBox.y + scrubberBox.height / 2;

    await page.mouse.move(scrubberCenterX, scrubberCenterY);
    await page.mouse.down();
    await page.mouse.move(scrubberCenterX + 90, scrubberCenterY, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(100);

    const forwardFrame = await getCanvasDataUrl(page);
    const forwardOffset = Number(
      await frameScrubber.getAttribute("data-frame-offset"),
    );

    if (forwardOffset <= 0 || forwardFrame === laterPausedFrame) {
      throw new Error(`${viewport.name} frame scrubber did not scrub forward`);
    }

    await page.mouse.move(scrubberCenterX, scrubberCenterY);
    await page.mouse.down();
    await page.mouse.move(scrubberCenterX - 150, scrubberCenterY, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(100);

    const backwardFrame = await getCanvasDataUrl(page);
    const backwardOffset = Number(
      await frameScrubber.getAttribute("data-frame-offset"),
    );

    if (backwardOffset >= forwardOffset || backwardFrame === forwardFrame) {
      throw new Error(`${viewport.name} frame scrubber did not scrub backward`);
    }

    await page.getByRole("button", { name: /play/i }).click();
    const playingSliderValue = await frameScrubber.getAttribute("data-frame-offset");

    if (playingSliderValue !== "0") {
      throw new Error(`${viewport.name} frame scrubber did not return to center`);
    }

    await page.getByRole("button", { name: /visual overlay/i }).click();
    await page.getByRole("menuitem", { name: /star/i }).click();
    await page.getByRole("menuitem", { name: /dark/i }).click();
    await page.keyboard.press("Escape");
    await page.locator(".format-frame img").first().waitFor();

    await page.getByRole("button", { name: /export current format/i }).click();
    await page.getByText("Image", { exact: true }).waitFor();
    await page.getByRole("menuitem", { name: /^png 1x$/i }).waitFor();
    await page.getByRole("menuitem", { name: /png 2x/i }).waitFor();
    await page.getByText("Video", { exact: true }).waitFor();
    await page.getByRole("menuitem", { name: /webm/i }).waitFor();
    await page.getByRole("menuitem", { name: /mp4/i }).waitFor();
    await page.getByText("Video duration").waitFor();
    await page.getByRole("menuitemcheckbox", { name: /15 seconds/i }).waitFor();
    const durationOption = page.getByRole("menuitemcheckbox", {
      name: /30 seconds/i,
    });
    await durationOption.click();

    if ((await durationOption.getAttribute("aria-checked")) !== "true") {
      throw new Error(`${viewport.name} video duration was not selectable`);
    }

    const loopOption = page.getByRole("menuitemcheckbox", {
      name: /loopable video/i,
    });
    await loopOption.click();

    if ((await loopOption.getAttribute("aria-checked")) !== "true") {
      throw new Error(`${viewport.name} loopable video option was not selectable`);
    }

    await page.keyboard.press("Escape");

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: /export current format/i }).click();
    await page.getByRole("menuitem", { name: /^png 1x$/i }).click();
    const download = await downloadPromise;

    if (!download.suggestedFilename().endsWith(".png")) {
      throw new Error(
        `${viewport.name} export did not produce a PNG filename: ${download.suggestedFilename()}`,
      );
    }

    await page.getByRole("button", { name: /save to gallery/i }).click();
    await page.getByRole("tab", { name: /gallery/i }).click();
    await page.locator("[data-gallery-item]").first().waitFor();

    const sectionName = `Moodboards ${viewport.name}`;
    await page.getByLabel("Section name").fill(sectionName);
    await page.getByRole("button", { name: /create section/i }).click();
    await page.locator("[data-gallery-save-status='saved']").waitFor();
    const savedItem = page.locator("[data-gallery-item]").first();
    const targetSection = page.locator(`[data-gallery-section="${sectionName}"]`);
    const savedVisualId = await savedItem.getAttribute("data-visual-id");

    if (!savedVisualId) {
      throw new Error(`${viewport.name} saved gallery item did not expose an id`);
    }

    await targetSection.scrollIntoViewIfNeeded();
    await savedItem.dragTo(targetSection, { force: true });

    let movedItems = await targetSection.locator("[data-gallery-item]").count();

    if (movedItems === 0) {
      await page.evaluate(
        ({ sectionName: droppedSectionName, visualId }) => {
          const section = document.querySelector(
            `[data-gallery-section="${droppedSectionName}"]`,
          );

          if (!section) {
            return;
          }

          const dataTransfer = new DataTransfer();
          dataTransfer.setData("text/plain", visualId);
          section.dispatchEvent(
            new DragEvent("dragover", {
              bubbles: true,
              cancelable: true,
              dataTransfer,
            }),
          );
          section.dispatchEvent(
            new DragEvent("drop", {
              bubbles: true,
              cancelable: true,
              dataTransfer,
            }),
          );
        },
        { sectionName, visualId: savedVisualId },
      );
    }

    await targetSection.locator("[data-gallery-item]").first().waitFor();
    await page.locator("[data-gallery-save-status='saved']").waitFor();

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("canvas.shader-stage");
    await page.getByRole("tab", { name: /gallery/i }).click();
    await page
      .locator(`[data-gallery-section="${sectionName}"] [data-gallery-item]`)
      .first()
      .waitFor();
    await page
      .locator(`[data-gallery-section="${sectionName}"] [data-gallery-item]`)
      .first()
      .click();

    const galleryTabSelected = await page
      .getByRole("tab", { name: /gallery/i })
      .getAttribute("aria-selected");

    if (galleryTabSelected !== "true") {
      throw new Error(`${viewport.name} gallery selection changed tabs`);
    }

    await page.getByRole("tab", { name: /generate/i }).click();

    for (const ratio of ratios) {
      await page.getByRole("button", { name: new RegExp(ratio.label) }).click();
      await page.waitForTimeout(100);

      const frameRatio = await page.evaluate(() => {
        const frame = document.querySelector(".format-frame");

        if (!(frame instanceof HTMLElement)) {
          return 0;
        }

        const rect = frame.getBoundingClientRect();
        return rect.width / rect.height;
      });

      if (Math.abs(frameRatio - ratio.value) > 0.035) {
        throw new Error(
          `${viewport.name} ${ratio.label} frame ratio mismatch: expected ${ratio.value}, got ${frameRatio}`,
        );
      }
    }

    await page.getByRole("button", { name: /all artboard/i }).click();
    await page.waitForTimeout(250);

    const overviewStats = await page.evaluate(() => {
      const preview = document.querySelector(".preview-area");
      const overview = document.querySelector("[data-format-overview]");
      const frames = document.querySelectorAll("[data-overview-frame]");

      if (!(preview instanceof HTMLElement) || !(overview instanceof HTMLElement)) {
        return { ready: false };
      }

      const previewRect = preview.getBoundingClientRect();
      const overviewRect = overview.getBoundingClientRect();

      return {
        frameCount: frames.length,
        fitsHeight: overviewRect.height <= previewRect.height + 1,
        fitsWidth: overviewRect.width <= previewRect.width + 1,
        ready: true,
      };
    });

    if (
      !overviewStats.ready ||
      overviewStats.frameCount !== ratios.length ||
      !overviewStats.fitsWidth ||
      !overviewStats.fitsHeight
    ) {
      throw new Error(
        `${viewport.name} all-format overview did not fit: ${JSON.stringify(
          overviewStats,
        )}`,
      );
    }

    const allFormatDownloads = [];
    const collectAllFormatDownload = (download) => {
      allFormatDownloads.push(download);
    };

    page.on("download", collectAllFormatDownload);
    await page.getByRole("button", { name: /export all formats/i }).click();
    await page.getByRole("menuitem", { name: /^png 1x$/i }).click();

    const allFormatDownloadDeadline = Date.now() + 5000;

    while (
      allFormatDownloads.length < ratios.length &&
      Date.now() < allFormatDownloadDeadline
    ) {
      await page.waitForTimeout(100);
    }

    page.off("download", collectAllFormatDownload);

    const allFormatFilenames = allFormatDownloads.map((download) =>
      download.suggestedFilename(),
    );

    if (
      allFormatDownloads.length !== ratios.length ||
      allFormatFilenames.some((filename) => !filename.endsWith(".png"))
    ) {
      throw new Error(
        `${viewport.name} all-format export did not produce PNGs: ${JSON.stringify(
          allFormatFilenames,
        )}`,
      );
    }

    await page.close();

    if (
      !stats.ready ||
      stats.canvasWidth < 180 ||
      stats.canvasHeight < 180 ||
      stats.frameWidth < 180 ||
      stats.frameHeight < 180 ||
      Math.abs(stats.frameRatio - 1) > 0.03 ||
      stats.uniqueColors < 20 ||
      stats.brightPixels < 80 ||
      stats.variance < 0.00015
    ) {
      throw new Error(
        `${viewport.name} canvas looks blank or under-rendered: ${JSON.stringify(
          stats,
        )}`,
      );
    }

    console.log(`${viewport.name}: ${JSON.stringify(stats)}`);
  }
} finally {
  await browser.close();
  await writeRemoteGalleryState(targetUrl, originalGalleryState);
}

async function getCanvasDataUrl(page) {
  return evaluateWithRetry(page, () => {
    const canvas = document.querySelector("canvas.shader-stage");

    if (!(canvas instanceof HTMLCanvasElement)) {
      return "";
    }

    return canvas.toDataURL("image/png");
  });
}

async function evaluateWithRetry(page, callback) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await page.evaluate(callback);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";

      if (!message.includes("Execution context was destroyed") || attempt === 2) {
        throw error;
      }

      await page.waitForSelector("canvas.shader-stage");
      await page.waitForTimeout(250);
    }
  }

  throw new Error("Page evaluation failed.");
}

async function readRemoteGalleryState(baseUrl) {
  const response = await fetch(new URL("/api/gallery", baseUrl));

  if (!response.ok) {
    throw new Error(`Could not read gallery API: ${response.status}`);
  }

  return response.json();
}

async function writeRemoteGalleryState(baseUrl, galleryState) {
  const response = await fetch(new URL("/api/gallery", baseUrl), {
    body: JSON.stringify(galleryState),
    headers: { "Content-Type": "application/json" },
    method: "PUT",
  });

  if (!response.ok) {
    throw new Error(`Could not write gallery API: ${response.status}`);
  }
}
