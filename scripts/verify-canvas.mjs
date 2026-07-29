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
const formats = [
  { label: "1:1", value: 1 },
  { label: "3:4", value: 3 / 4 },
  { label: "4:3", value: 4 / 3 },
  { label: "16:9", value: 16 / 9 },
  { label: "9:16", value: 9 / 16 },
];

await mkdir(artifactDir, { recursive: true });

let browser;

try {
  browser = await chromium.launch();

  for (const viewport of viewports) {
    const page = await browser.newPage({
      deviceScaleFactor: 1,
      viewport: { height: viewport.height, width: viewport.width },
    });
    const readIsolatedGalleryState = await installIsolatedGalleryApi(
      page,
      defaultGalleryState,
      { injectConcurrentSection: viewport.name === "desktop" },
    );

    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("canvas.shader-stage");
    await page.waitForTimeout(500);
    await verifyPresetPreviewDefaultsAndGrid(page, viewport);

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

    const sampleAudioButton = page.getByRole("button", {
      name: /play sample audio/i,
    });
    await sampleAudioButton.click();
    await page.waitForFunction(
      () => {
        const frame = document.querySelector(".format-frame");

        if (!(frame instanceof HTMLElement)) {
          return false;
        }

        return (
          Number.parseFloat(
            getComputedStyle(frame).getPropertyValue("--frame-audio-level"),
          ) > 0.005
        );
      },
      null,
      { timeout: 10_000 },
    );
    await verifyWaveformGeometry(page, viewport.name);
    await verifyWaveformFormatExtents(page, viewport.name);
    await page.screenshot({
      path: join(artifactDir, `waveform-${viewport.name}.png`),
    });
    await page.getByRole("button", { name: /pause sample audio/i }).click();
    await page.getByRole("button", { name: /play sample audio/i }).waitFor();

    if (viewport.name === "desktop") {
      await verifyAudioSpectrumParity(page);
      await verifyWaveformFrequencySidechain(page);
      await verifyWaveformAmplitudeProfile(page);
      await verifyWaveformCapsuleHeight(page);
      await verifyBlobChainMapping(page);
    }

    const grainSlider = page.getByRole("slider", { name: /^grain$/i });
    const grainValue = Number(await grainSlider.getAttribute("aria-valuenow"));
    await page.getByRole("button", { name: /composition/i }).click();
    await page.waitForTimeout(50);

    const randomizedGrainValue = Number(await grainSlider.getAttribute("aria-valuenow"));

    if (Math.abs(randomizedGrainValue - grainValue) > 0.0005) {
      throw new Error(`${viewport.name} composition randomizer changed grain`);
    }

    for (const [audioControlName, expectedValue] of [
      ["Audio Reactivity", 45],
      ["Audio Smoothness", 18],
    ]) {
      const actualValue = Number(
        await page
          .getByRole("slider", { name: audioControlName })
          .getAttribute("aria-valuenow"),
      );

      if (actualValue !== expectedValue) {
        throw new Error(
          `${viewport.name} new composition ${audioControlName} was ${actualValue}, expected ${expectedValue}`,
        );
      }
    }

    await page.getByRole("button", { name: /pause visual timeline/i }).click();
    await page.getByRole("button", { name: /play visual timeline/i }).waitFor();
    const pausedFrame = await getCanvasDataUrl(page);
    await page.waitForTimeout(250);
    const laterPausedFrame = await getCanvasDataUrl(page);

    if (pausedFrame !== laterPausedFrame) {
      throw new Error(`${viewport.name} pause did not freeze the canvas frame`);
    }

    let anchorControlFrame = laterPausedFrame;

    for (const controlName of [
      "X",
      "Y",
      "Size",
      "Ellipse",
      "Bend",
      "Taper",
      "Opacity",
    ]) {
      const control = page
        .getByRole("slider", { name: new RegExp(`^${controlName}$`, "i") })
        .first();
      const currentValue = Number(await control.getAttribute("aria-valuenow"));
      const minValue = Number(await control.getAttribute("aria-valuemin"));
      const maxValue = Number(await control.getAttribute("aria-valuemax"));
      const key = currentValue > (minValue + maxValue) / 2 ? "Home" : "End";

      await control.focus();
      await page.keyboard.press(key);
      await page.waitForTimeout(75);
      const nextAnchorControlFrame = await getCanvasDataUrl(page);

      if (nextAnchorControlFrame === anchorControlFrame) {
        throw new Error(
          `${viewport.name} ${controlName} anchor control did not affect the shader`,
        );
      }

      anchorControlFrame = nextAnchorControlFrame;
    }

    const frameScrubber = page.locator("[data-frame-scrubber]");
    await frameScrubber.scrollIntoViewIfNeeded();
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

    // Normalize the scrub position before testing relative motion. The
    // randomized composition can legitimately start anywhere in the range.
    await page.mouse.click(scrubberCenterX, scrubberCenterY);
    await page.waitForTimeout(100);
    const centeredFrame = await getCanvasDataUrl(page);
    const centeredOffset = Number(
      await frameScrubber.getAttribute("data-frame-offset"),
    );
    const timelineThumb = page.getByRole("slider", { name: /^timeline$/i });
    const forwardThumbBox = await timelineThumb.boundingBox();

    if (!forwardThumbBox) {
      throw new Error(`${viewport.name} timeline thumb was not visible`);
    }

    const forwardThumbX = forwardThumbBox.x + forwardThumbBox.width / 2;
    const forwardThumbY = forwardThumbBox.y + forwardThumbBox.height / 2;

    await page.mouse.move(forwardThumbX, forwardThumbY);
    await page.mouse.down();
    await page.mouse.move(forwardThumbX + 90, forwardThumbY, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(100);

    const forwardFrame = await getCanvasDataUrl(page);
    const forwardOffset = Number(
      await frameScrubber.getAttribute("data-frame-offset"),
    );

    if (forwardOffset <= centeredOffset || forwardFrame === centeredFrame) {
      throw new Error(
        `${viewport.name} frame scrubber did not scrub forward ` +
          `(center=${centeredOffset}, forward=${forwardOffset}, changed=${forwardFrame !== centeredFrame})`,
      );
    }

    const backwardThumbBox = await timelineThumb.boundingBox();

    if (!backwardThumbBox) {
      throw new Error(`${viewport.name} timeline thumb disappeared`);
    }

    const backwardThumbX = backwardThumbBox.x + backwardThumbBox.width / 2;
    const backwardThumbY = backwardThumbBox.y + backwardThumbBox.height / 2;

    await page.mouse.move(backwardThumbX, backwardThumbY);
    await page.mouse.down();
    await page.mouse.move(backwardThumbX - 150, backwardThumbY, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(100);

    const backwardFrame = await getCanvasDataUrl(page);
    const backwardOffset = Number(
      await frameScrubber.getAttribute("data-frame-offset"),
    );

    if (backwardOffset >= forwardOffset || backwardFrame === forwardFrame) {
      throw new Error(`${viewport.name} frame scrubber did not scrub backward`);
    }

    // Force the render phase beyond the bounded slider range, resume briefly,
    // then pause again. The thumb must re-center and a small relative drag must
    // advance from the unbounded phase instead of snapping back below 500000.
    await timelineThumb.focus();
    await page.keyboard.press("End");
    await page.getByRole("button", { name: /play visual timeline/i }).click();
    await page.waitForTimeout(75);
    await page.getByRole("button", { name: /pause visual timeline/i }).click();
    await page.waitForTimeout(75);
    await timelineThumb.focus();
    await page.keyboard.press("End");
    await page.waitForTimeout(100);
    const forcedUnboundedFrame = Number(
      await frameScrubber.getAttribute("data-render-frame"),
    );

    if (forcedUnboundedFrame <= 500_000) {
      throw new Error(
        `${viewport.name} could not force an unbounded render frame: ${forcedUnboundedFrame}`,
      );
    }

    await page.getByRole("button", { name: /play visual timeline/i }).click();
    await page.waitForTimeout(150);
    await page.getByRole("button", { name: /pause visual timeline/i }).click();
    await page.waitForTimeout(100);

    const longPausedFrame = Number(
      await frameScrubber.getAttribute("data-render-frame"),
    );
    const recenteredOffset = Number(
      await frameScrubber.getAttribute("data-frame-offset"),
    );

    if (longPausedFrame <= 500_000 || recenteredOffset !== 0) {
      throw new Error(
        `${viewport.name} long pause did not preserve/recenter the phase: ` +
          `${longPausedFrame}/${recenteredOffset}`,
      );
    }

    const longPausedCanvas = await getCanvasDataUrl(page);
    const recenteredThumbBox = await timelineThumb.boundingBox();

    if (!recenteredThumbBox) {
      throw new Error(`${viewport.name} recentered timeline thumb disappeared`);
    }

    const recenteredThumbX =
      recenteredThumbBox.x + recenteredThumbBox.width / 2;
    const recenteredThumbY =
      recenteredThumbBox.y + recenteredThumbBox.height / 2;
    await page.mouse.move(recenteredThumbX, recenteredThumbY);
    await page.mouse.down();
    await page.mouse.move(recenteredThumbX + 35, recenteredThumbY, {
      steps: 5,
    });
    await page.mouse.up();
    await page.waitForTimeout(100);

    const relativeLongFrame = Number(
      await frameScrubber.getAttribute("data-render-frame"),
    );
    const relativeLongCanvas = await getCanvasDataUrl(page);

    if (
      relativeLongFrame <= longPausedFrame ||
      relativeLongFrame - longPausedFrame >= 150_000 ||
      relativeLongCanvas === longPausedCanvas
    ) {
      throw new Error(
        `${viewport.name} unbounded relative scrub jumped or did not render: ` +
          `${longPausedFrame} -> ${relativeLongFrame}`,
      );
    }

    await page.getByRole("button", { name: /play visual timeline/i }).click();
    const playingSliderValue = await frameScrubber.getAttribute("data-frame-offset");

    if (playingSliderValue !== "0") {
      throw new Error(`${viewport.name} frame scrubber did not return to center`);
    }

    const formatToggles = page.locator(".format-toggle");

    if ((await formatToggles.count()) !== formats.length) {
      throw new Error(
        `${viewport.name} format toggle count mismatch: expected ${formats.length}, got ${await formatToggles.count()}`,
      );
    }

    for (const formatOption of formats) {
      const toggle = formatToggles.filter({ hasText: formatOption.label }).first();

      if ((await toggle.getAttribute("aria-pressed")) !== "true") {
        await toggle.click();
        await page.waitForFunction(
          (label) =>
            Array.from(document.querySelectorAll(".format-toggle")).some(
              (candidate) =>
                candidate.textContent?.includes(label) &&
                candidate.getAttribute("aria-pressed") === "true",
            ),
          formatOption.label,
        );
      }

      const frame = page.locator(
        `.format-frame[data-format-label="${formatOption.label}"]`,
      );
      await frame.waitFor();
      const frameBox = await frame.boundingBox();

      if (!frameBox) {
        throw new Error(`${viewport.name} ${formatOption.label} frame was not visible`);
      }

      const frameRatio = frameBox.width / frameBox.height;

      if (Math.abs(frameRatio - formatOption.value) > 0.035) {
        throw new Error(
          `${viewport.name} ${formatOption.label} frame ratio mismatch: expected ${formatOption.value}, got ${frameRatio}`,
        );
      }
    }

    const selectedFormatCount = await page
      .locator(".format-toggle[aria-pressed='true']")
      .count();
    const renderedFormatCount = await page
      .locator(".format-overview .format-overview-item")
      .count();

    if (
      selectedFormatCount !== formats.length ||
      renderedFormatCount !== formats.length
    ) {
      throw new Error(
        `${viewport.name} selected/rendered format mismatch: ${selectedFormatCount}/${renderedFormatCount}`,
      );
    }

    if (viewport.name === "desktop") {
      const allFormatDownloads = [];
      const collectAllFormatDownload = (download) => {
        allFormatDownloads.push(download);
      };

      page.on("download", collectAllFormatDownload);
      await page
        .getByRole("button", { name: /export png 2x \(5 formats\)/i })
        .click();

      const allFormatDownloadDeadline = Date.now() + 30_000;

      while (
        allFormatDownloads.length < formats.length &&
        Date.now() < allFormatDownloadDeadline
      ) {
        await page.waitForTimeout(100);
      }

      page.off("download", collectAllFormatDownload);
      const allFormatFilenames = allFormatDownloads.map((download) =>
        download.suggestedFilename(),
      );

      if (
        allFormatDownloads.length !== formats.length ||
        allFormatFilenames.some((filename) => !filename.endsWith("-2x.png"))
      ) {
        throw new Error(
          `${viewport.name} multi-format PNG export failed: ${JSON.stringify(
            allFormatFilenames,
          )}`,
        );
      }
    }

    for (const formatOption of formats.slice(1)) {
      const toggle = formatToggles.filter({ hasText: formatOption.label }).first();

      if ((await toggle.getAttribute("aria-pressed")) === "true") {
        await toggle.click();
        await page.waitForFunction(
          (label) =>
            Array.from(document.querySelectorAll(".format-toggle")).some(
              (candidate) =>
                candidate.textContent?.includes(label) &&
                candidate.getAttribute("aria-pressed") === "false",
            ),
          formatOption.label,
        );
      }
    }

    const squareToggle = formatToggles.filter({ hasText: "1:1" }).first();
    await squareToggle.click();
    await squareToggle.click();

    if ((await squareToggle.getAttribute("aria-pressed")) !== "true") {
      throw new Error(`${viewport.name} could not restore the 1:1 export format`);
    }

    if (viewport.name === "mobile") {
      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: /^export png 2x$/i }).click();
      const download = await downloadPromise;

      if (!download.suggestedFilename().endsWith("-2x.png")) {
        throw new Error(
          `${viewport.name} export did not produce a PNG filename: ${download.suggestedFilename()}`,
        );
      }
    }

    for (const audioControlName of [
      "Audio Reactivity",
      "Audio Smoothness",
    ]) {
      const audioControl = page.getByRole("slider", {
        name: audioControlName,
      });
      await audioControl.focus();
      await page.keyboard.press("Home");
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

    const persistedGalleryState = readIsolatedGalleryState();
    const persistedVisual = persistedGalleryState.items.find(
      (item) => item.id === savedVisualId,
    );

    if (
      viewport.name === "desktop" &&
      !persistedGalleryState.sections.some(
        (section) => section.id === "concurrent-remote-section",
      )
    ) {
      throw new Error(
        "desktop gallery conflict merge dropped the concurrent remote section",
      );
    }

    if (
      persistedVisual?.mesh?.audioReactivity !== 45 ||
      persistedVisual?.mesh?.audioSmoothness !== 18
    ) {
      throw new Error(
        `${viewport.name} saved preset did not persist 90% audio defaults`,
      );
    }

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("canvas.shader-stage");
    await page.getByRole("tab", { name: /generate/i }).click();

    const preLoadFormatToggles = page.locator(".format-toggle");

    for (const formatOption of formats.slice(1)) {
      const toggle = preLoadFormatToggles
        .filter({ hasText: formatOption.label })
        .first();

      if ((await toggle.getAttribute("aria-pressed")) === "true") {
        await toggle.click();
      }
    }

    for (const audioControlName of [
      "Audio Reactivity",
      "Audio Smoothness",
    ]) {
      const audioControl = page.getByRole("slider", {
        name: audioControlName,
      });
      await audioControl.focus();
      await page.keyboard.press("Home");
    }

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
    await verifyPresetPreviewDefaultsAndGrid(page, viewport);

    const restoredFormatToggles = page.locator(".format-toggle");

    if ((await restoredFormatToggles.count()) !== formats.length) {
      throw new Error(`${viewport.name} format toggles were not restored after reload`);
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
  await browser?.close();
}

async function verifyPresetPreviewDefaultsAndGrid(page, viewport) {
  const defaults = await page.evaluate(() => {
    const previewArea = document.querySelector(".preview-area");
    const square = document.querySelector(
      '.format-frame[data-format-label="1:1"]',
    );
    const shell = document.querySelector(".app-shell");

    if (
      !(previewArea instanceof HTMLElement) ||
      !(square instanceof HTMLElement) ||
      !(shell instanceof HTMLElement)
    ) {
      return { ready: false };
    }

    const previewRect = previewArea.getBoundingClientRect();
    const squareRect = square.getBoundingClientRect();
    const gridStyle = getComputedStyle(shell, "::before");
    const audioValues = Object.fromEntries(
      Array.from(document.querySelectorAll("[data-range-control]"))
        .filter((control) =>
          ["Audio Reactivity", "Audio Smoothness"].includes(
            control.getAttribute("data-range-control") ?? "",
          ),
        )
        .map((control) => [
          control.getAttribute("data-range-control"),
          Number(
            control
              .querySelector('[role="slider"]')
              ?.getAttribute("aria-valuenow"),
          ),
        ]),
    );

    return {
      audioValues,
      centerDelta:
        squareRect.left +
        squareRect.width / 2 -
        (previewRect.left + previewRect.width / 2),
      gridBackgroundImage: gridStyle.backgroundImage,
      gridMaskImage: gridStyle.maskImage || gridStyle.webkitMaskImage,
      gridPointerEvents: gridStyle.pointerEvents,
      pressedFormats: document.querySelectorAll(
        '.format-toggle[aria-pressed="true"]',
      ).length,
      primaryFormat: document
        .querySelector(".format-overview")
        ?.getAttribute("data-primary-format"),
      ready: true,
      renderedFormats: document.querySelectorAll(
        ".format-overview .format-overview-item",
      ).length,
    };
  });

  if (
    !defaults.ready ||
    defaults.pressedFormats !== formats.length ||
    defaults.renderedFormats !== formats.length ||
    defaults.primaryFormat !== "1:1" ||
    Math.abs(defaults.centerDelta) > 1 ||
    defaults.audioValues?.["Audio Reactivity"] !== 45 ||
    defaults.audioValues?.["Audio Smoothness"] !== 18
  ) {
    throw new Error(
      `${viewport.name} preset defaults are incorrect: ${JSON.stringify(defaults)}`,
    );
  }

  if (
    defaults.gridMaskImage === "none" ||
    !defaults.gridBackgroundImage?.includes("radial-gradient") ||
    defaults.gridPointerEvents !== "none"
  ) {
    throw new Error(
      `${viewport.name} masked preview grid is incorrect: ${JSON.stringify(defaults)}`,
    );
  }

  const dragStart = {
    x: viewport.width - 24,
    y: Math.min(150, viewport.height * 0.2),
  };
  const dragDelta = { x: -60, y: 40 };
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(
    dragStart.x + dragDelta.x,
    dragStart.y + dragDelta.y,
    { steps: 5 },
  );
  await page.mouse.up();

  const moved = await page.evaluate(() => {
    const artboard = document.querySelector(".preview-artboard");
    const shell = document.querySelector(".app-shell");

    if (!(artboard instanceof HTMLElement) || !(shell instanceof HTMLElement)) {
      return null;
    }

    return {
      gridX: Number.parseFloat(
        shell.style.getPropertyValue("--preview-grid-pan-x"),
      ),
      gridY: Number.parseFloat(
        shell.style.getPropertyValue("--preview-grid-pan-y"),
      ),
      visualX: Number.parseFloat(
        artboard.style.getPropertyValue("--preview-pan-x"),
      ),
      visualY: Number.parseFloat(
        artboard.style.getPropertyValue("--preview-pan-y"),
      ),
    };
  });

  if (
    !moved ||
    Math.abs(moved.visualX - dragDelta.x) > 0.1 ||
    Math.abs(moved.visualY - dragDelta.y) > 0.1 ||
    Math.abs(moved.gridX - moved.visualX * 0.5) > 0.1 ||
    Math.abs(moved.gridY - moved.visualY * 0.5) > 0.1
  ) {
    throw new Error(
      `${viewport.name} preview grid parallax is incorrect: ${JSON.stringify(moved)}`,
    );
  }

  await page.mouse.move(
    dragStart.x + dragDelta.x,
    dragStart.y + dragDelta.y,
  );
  await page.mouse.down();
  await page.mouse.move(dragStart.x, dragStart.y, { steps: 5 });
  await page.mouse.up();
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

async function verifyAudioSpectrumParity(page) {
  await page.evaluate(async () => {
    const [liveModule, offlineModule] = await Promise.all([
      import("/src/lib/audioSpectrum.ts"),
      import("/src/export/audioAnalysis.ts"),
    ]);
    const trigger = document.createElement("button");
    trigger.setAttribute("aria-hidden", "true");
    trigger.dataset.audioParityTrigger = "true";
    trigger.style.cssText =
      "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;z-index:9999";
    document.body.appendChild(trigger);
    window.__outcraftAudioParityResult = null;

    trigger.addEventListener(
      "click",
      async () => {
        const audioContext = new AudioContext({ sampleRate: 48_000 });
        const analyser = audioContext.createAnalyser();
        liveModule.configureLiveAudioAnalyser(analyser);
        const oscillator = audioContext.createOscillator();
        const signalGain = audioContext.createGain();
        const muteGain = audioContext.createGain();
        const exactBin = 48;
        const frequency =
          (audioContext.sampleRate * exactBin) / analyser.fftSize;
        signalGain.gain.value = 0.1;
        muteGain.gain.value = 0;
        oscillator.frequency.value = frequency;
        oscillator.connect(signalGain);
        signalGain.connect(analyser);
        analyser.connect(muteGain);
        muteGain.connect(audioContext.destination);
        oscillator.start();

        try {
          await audioContext.resume();
          await new Promise((resolve) => setTimeout(resolve, 180));

          const decibels = new Float32Array(analyser.frequencyBinCount);
          const liveSpectrum = new Float32Array(
            liveModule.AUDIO_SPECTRUM_BAND_COUNT,
          );
          analyser.getFloatFrequencyData(decibels);
          liveModule.writeLogSpectrumFromDecibels(
            decibels,
            audioContext.sampleRate,
            analyser.fftSize,
            liveSpectrum,
          );

          const audioBuffer = audioContext.createBuffer(
            1,
            audioContext.sampleRate,
            audioContext.sampleRate,
          );
          const samples = audioBuffer.getChannelData(0);

          for (let index = 0; index < samples.length; index += 1) {
            samples[index] =
              Math.sin(
                (2 * Math.PI * frequency * index) /
                  audioContext.sampleRate,
              ) * 0.1;
          }

          const offlineSpectrum = new Float32Array(
            liveModule.AUDIO_SPECTRUM_BAND_COUNT,
          );
          offlineModule
            .createAudioSpectrumAnalyzer(audioBuffer, 30)
            .analyzeFrame(2, offlineSpectrum);
          const livePeak = Math.max(...liveSpectrum);
          const offlinePeak = Math.max(...offlineSpectrum);
          const livePeakBand = liveSpectrum.indexOf(livePeak);
          const offlinePeakBand = offlineSpectrum.indexOf(offlinePeak);
          const voiceFocusedSpectrum = new Float32Array(
            liveModule.AUDIO_SPECTRUM_BAND_COUNT,
          );
          const voiceBand =
            Math.log(
              liveModule.AUDIO_WAVEFORM_MIN_FREQUENCY_HZ /
                liveModule.AUDIO_SPECTRUM_MIN_FREQUENCY_HZ,
            ) /
            Math.log(
              liveModule.AUDIO_SPECTRUM_MAX_FREQUENCY_HZ /
                liveModule.AUDIO_SPECTRUM_MIN_FREQUENCY_HZ,
            ) *
            liveModule.AUDIO_SPECTRUM_BAND_COUNT;

          for (
            let index = Math.max(0, Math.floor(voiceBand) - 2);
            index <=
            Math.min(
              voiceFocusedSpectrum.length - 1,
              Math.ceil(voiceBand) + 2,
            );
            index += 1
          ) {
            voiceFocusedSpectrum[index] = 1;
          }

          window.__outcraftAudioParityResult = {
            delta: Math.abs(livePeak - offlinePeak),
            livePeak,
            livePeakBand,
            offlinePeak,
            offlinePeakBand,
            waveformCenter: liveModule.sampleWaveformSpectrum(
              voiceFocusedSpectrum,
              0,
            ),
            waveformEdge: liveModule.sampleWaveformSpectrum(
              voiceFocusedSpectrum,
              1,
            ),
          };
        } catch (error) {
          window.__outcraftAudioParityResult = {
            error: error instanceof Error ? error.message : String(error),
          };
        } finally {
          oscillator.stop();
          await audioContext.close().catch(() => undefined);
          trigger.remove();
        }
      },
      { once: true },
    );
  });

  await page.locator("[data-audio-parity-trigger]").click({ force: true });
  await page.waitForFunction(
    () => window.__outcraftAudioParityResult !== null,
    null,
    { timeout: 10_000 },
  );
  const result = await page.evaluate(() => window.__outcraftAudioParityResult);

  if (
    result?.error ||
    result?.livePeakBand !== result?.offlinePeakBand ||
    !Number.isFinite(result?.delta) ||
    result.delta > 0.02 ||
    result.waveformCenter < 0.5 ||
    result.waveformEdge > 0.05
  ) {
    throw new Error(
      `Live/offline audio spectrum mismatch: ${JSON.stringify(result)}`,
    );
  }
}

async function verifyWaveformFrequencySidechain(page) {
  const result = await page.evaluate(async () => {
    const spectrumModule = await import("/src/lib/audioSpectrum.ts");
    const {
      AUDIO_SPECTRUM_BAND_COUNT,
      AUDIO_SPECTRUM_MAX_FREQUENCY_HZ,
      AUDIO_SPECTRUM_MIN_FREQUENCY_HZ,
      AUDIO_WAVEFORM_FULL_RESPONSE_MAX_FREQUENCY_HZ,
      AUDIO_WAVEFORM_MAX_FREQUENCY_HZ,
      AUDIO_WAVEFORM_MIN_FREQUENCY_HZ,
      getWaveformFrequencyAtProgress,
      getWaveformFrequencyWeight,
      sampleWaveformSpectrum,
    } = spectrumModule;
    const progressAtFrequency = (frequency) =>
      Math.log(frequency / AUDIO_WAVEFORM_MIN_FREQUENCY_HZ) /
      Math.log(
        AUDIO_WAVEFORM_MAX_FREQUENCY_HZ /
          AUDIO_WAVEFORM_MIN_FREQUENCY_HZ,
      );
    const sourceBandCenterFrequency = (index) =>
      AUDIO_SPECTRUM_MIN_FREQUENCY_HZ *
      (
        AUDIO_SPECTRUM_MAX_FREQUENCY_HZ /
        AUDIO_SPECTRUM_MIN_FREQUENCY_HZ
      ) **
        ((index + 0.5) / AUDIO_SPECTRUM_BAND_COUNT);
    const lowVoiceFrequency = 120;
    const lowVoiceSpectrum = new Float32Array(
      AUDIO_SPECTRUM_BAND_COUNT,
    );
    let lowVoiceBand = 0;
    let lowVoiceDistance = Number.POSITIVE_INFINITY;

    for (
      let index = 0;
      index < AUDIO_SPECTRUM_BAND_COUNT;
      index += 1
    ) {
      const distance = Math.abs(
        Math.log(
          sourceBandCenterFrequency(index) / lowVoiceFrequency,
        ),
      );

      if (distance < lowVoiceDistance) {
        lowVoiceDistance = distance;
        lowVoiceBand = index;
      }
    }

    lowVoiceSpectrum[lowVoiceBand] = 1;

    const aboveCutoffSpectrum = new Float32Array(
      AUDIO_SPECTRUM_BAND_COUNT,
    );

    for (
      let index = 0;
      index < AUDIO_SPECTRUM_BAND_COUNT;
      index += 1
    ) {
      if (
        sourceBandCenterFrequency(index) >
        AUDIO_WAVEFORM_MAX_FREQUENCY_HZ
      ) {
        aboveCutoffSpectrum[index] = 1;
      }
    }

    const aboveCutoffSamples = Array.from(
      { length: 65 },
      (_, index) =>
        sampleWaveformSpectrum(
          aboveCutoffSpectrum,
          index / 64,
        ),
    );
    const malformedSpectrum = new Float32Array(
      AUDIO_SPECTRUM_BAND_COUNT,
    ).fill(0.5);
    malformedSpectrum[3] = Number.NaN;
    malformedSpectrum[7] = Number.POSITIVE_INFINITY;
    const determinismProgress = [
      Number.NEGATIVE_INFINITY,
      -1,
      0,
      0.25,
      0.5,
      1,
      2,
      Number.POSITIVE_INFINITY,
      Number.NaN,
    ];
    const firstPass = determinismProgress.map((progress) =>
      sampleWaveformSpectrum(malformedSpectrum, progress),
    );
    const secondPass = determinismProgress.map((progress) =>
      sampleWaveformSpectrum(malformedSpectrum, progress),
    );

    return {
      aboveCutoffPeak: Math.max(...aboveCutoffSamples),
      deterministic:
        firstPass.every(
          (value, index) => value === secondPass[index],
        ),
      finite: firstPass.every(Number.isFinite),
      fullSpectrumMax: AUDIO_SPECTRUM_MAX_FREQUENCY_HZ,
      fullSpectrumMin: AUDIO_SPECTRUM_MIN_FREQUENCY_HZ,
      logarithmicMidpoint: getWaveformFrequencyAtProgress(0.5),
      lowVoiceResponse: sampleWaveformSpectrum(
        lowVoiceSpectrum,
        progressAtFrequency(
          sourceBandCenterFrequency(lowVoiceBand),
        ),
      ),
      rolloffMidpointWeight: getWaveformFrequencyWeight(7_500),
      waveformMaximum: AUDIO_WAVEFORM_MAX_FREQUENCY_HZ,
      waveformMinimum: AUDIO_WAVEFORM_MIN_FREQUENCY_HZ,
      weightAboveCutoff: getWaveformFrequencyWeight(9_000),
      weightAtCutoff: getWaveformFrequencyWeight(
        AUDIO_WAVEFORM_MAX_FREQUENCY_HZ,
      ),
      weightAtFullResponseEdge: getWaveformFrequencyWeight(
        AUDIO_WAVEFORM_FULL_RESPONSE_MAX_FREQUENCY_HZ,
      ),
    };
  });

  if (
    result.fullSpectrumMin !== 40 ||
    result.fullSpectrumMax !== 16_000 ||
    result.waveformMinimum !== 80 ||
    result.waveformMaximum !== 8_000 ||
    Math.abs(result.weightAtFullResponseEdge - 1) > 1e-8 ||
    result.weightAtCutoff !== 0 ||
    result.weightAboveCutoff !== 0 ||
    Math.abs(result.rolloffMidpointWeight - 0.5) > 1e-8 ||
    Math.abs(result.logarithmicMidpoint - 800) > 1e-8 ||
    result.aboveCutoffPeak !== 0 ||
    result.lowVoiceResponse < 0.95 ||
    !result.deterministic ||
    !result.finite
  ) {
    throw new Error(
      `Waveform frequency sidechain regression: ${JSON.stringify(result)}`,
    );
  }
}

async function verifyWaveformGeometry(page, viewportName) {
  const result = await page.evaluate(async () => {
    const geometryModule = await import("/src/lib/waveformGeometry.ts");
    const waveformModule = await import("/src/lib/waveformBars.ts");
    const frame = document.querySelector(".format-frame");
    const overlay = frame?.querySelector(".sound-wave-overlay");
    const bars = overlay
      ? Array.from(overlay.querySelectorAll(".sound-wave-overlay-bar"))
      : [];

    if (
      !(frame instanceof HTMLElement) ||
      !(overlay instanceof HTMLElement) ||
      bars.length === 0 ||
      bars.length % 2 === 0
    ) {
      return { error: "waveform DOM is incomplete" };
    }

    const frameRect = frame.getBoundingClientRect();
    const overlayRect = overlay.getBoundingClientRect();
    const barRects = bars.map((bar) => bar.getBoundingClientRect());
    const firstBarRect = barRects[0];
    const centerBarRect = barRects[Math.floor(barRects.length / 2)];
    const formatDimensions = {
      "1:1": [1080, 1080],
      "3:4": [1080, 1440],
      "4:3": [1440, 1080],
      "9:16": [1080, 1920],
      "16:9": [1920, 1080],
    };
    const formatLabel = frame.getAttribute("data-format-label") ?? "1:1";
    const [exportWidth, exportHeight] =
      formatDimensions[formatLabel] ?? formatDimensions["1:1"];
    const boxScale = Number.parseFloat(
      getComputedStyle(overlay).getPropertyValue(
        "--waveform-style-box-scale",
      ),
    );
    const amplitudeScale = Number.parseFloat(
      getComputedStyle(overlay).getPropertyValue(
        "--waveform-amplitude-scale",
      ),
    );
    const expected = geometryModule.getWaveformGeometry(
      exportWidth,
      exportHeight,
      boxScale,
    );
    const scaleX = frameRect.width / exportWidth;
    const scaleY = frameRect.height / exportHeight;
    const expectedBarWidth = expected.barWidth * scaleX;
    const maxBarWidthDelta = Math.max(
      ...barRects.map((rect) => Math.abs(rect.width - expectedBarWidth)),
    );
    const maxBarPositionDelta = Math.max(
      ...barRects.map((rect, index) =>
        Math.abs(
          rect.left -
            overlayRect.left -
            ((geometryModule.getWaveformBarOffset(
              index,
              expected.barStep,
              expected.pixelScale,
            ) +
              expected.barCenterInset) *
              scaleX -
              rect.width / 2),
        ),
      ),
    );
    const uniformBarWidthDelta = Math.max(
      ...barRects.map((rect) => Math.abs(rect.width - firstBarRect.width)),
    );
    const peakHeightRatio = Number.parseFloat(
      getComputedStyle(overlay).getPropertyValue(
        "--waveform-raw-peak-height-ratio",
      ),
    );
    const edgeBlurRadius =
      Math.min(exportWidth, exportHeight) *
      waveformModule.WAVEFORM_EDGE_BLUR_MAX_RATIO;
    const expectedAmplitudeScale = geometryModule.getWaveformAmplitudeScale(
      exportWidth,
      exportHeight,
      expected.height,
      peakHeightRatio,
      waveformModule.WAVEFORM_AMPLITUDE_SCALE,
      edgeBlurRadius,
    );

    return {
      actual: {
        amplitudeScale,
        barCount: bars.length,
        barWidth: firstBarRect.width,
        centerBarOffset: Math.abs(
          centerBarRect.left +
            centerBarRect.width / 2 -
            (overlayRect.left + overlayRect.width / 2),
        ),
        centerX: overlayRect.left + overlayRect.width / 2,
        height: overlayRect.height,
        maxBarPositionDelta,
        maxBarWidthDelta,
        uniformBarWidthDelta,
        width: overlayRect.width,
      },
      expected: {
        amplitudeScale: expectedAmplitudeScale,
        barCount: expected.barCount,
        barWidth: expectedBarWidth,
        centerX: frameRect.left + frameRect.width / 2,
        height: expected.height * scaleY,
        width: expected.width * scaleX,
      },
    };
  });

  if (result.error) {
    throw new Error(`${viewportName} waveform geometry: ${result.error}`);
  }

  for (const field of [
    "amplitudeScale",
    "barWidth",
    "centerX",
    "height",
    "width",
  ]) {
    const delta = Math.abs(result.actual[field] - result.expected[field]);
    const tolerance = field === "barWidth" ? 0.25 : 0.75;

    if (delta > tolerance) {
      throw new Error(
        `${viewportName} waveform ${field} mismatch: ` +
          `${result.actual[field]} vs ${result.expected[field]}`,
      );
    }
  }

  if (
    result.actual.barCount !== result.expected.barCount ||
    result.actual.centerBarOffset > 0.25 ||
    result.actual.maxBarPositionDelta > 0.35 ||
    result.actual.maxBarWidthDelta > 0.25 ||
    result.actual.uniformBarWidthDelta > 0.01
  ) {
    throw new Error(
      `${viewportName} waveform bars are not on a uniform grid: ` +
        JSON.stringify(result.actual),
    );
  }
}

async function verifyWaveformFormatExtents(page, viewportName) {
  let result = [];
  const activeFrameDeadline = Date.now() + 10_000;

  do {
    result = await page.evaluate(async () => {
    const geometryModule = await import("/src/lib/waveformGeometry.ts");
    const sceneGeometryModule = await import("/src/lib/sceneGeometry.ts");
    const waveformModule = await import("/src/lib/waveformBars.ts");
    const formatFrames = Array.from(
      document.querySelectorAll(".format-frame[data-format-label]"),
    );

    return formatFrames.map((frame) => {
      const overlay = frame.querySelector(".sound-wave-overlay");
      const logo = frame.querySelector(".scene-logo");
      const leftSlogan = frame.querySelector(
        '.scene-bottom-slogan[data-align="left"]',
      );
      const blurTrack = frame.querySelector(".sound-wave-overlay-track-blur");
      const glowTrack = frame.querySelector(".sound-wave-overlay-track-glow");
      const sharpTrack = frame.querySelector(".sound-wave-overlay-track-sharp");
      const bars = overlay
        ? Array.from(
            overlay.querySelectorAll(
              ".sound-wave-overlay-bar, .sound-wave-overlay-blur-bar",
            ),
          )
        : [];

      if (
        !(frame instanceof HTMLElement) ||
        !(overlay instanceof HTMLElement) ||
        !(logo instanceof HTMLElement) ||
        !(leftSlogan instanceof HTMLElement) ||
        !(blurTrack instanceof HTMLElement) ||
        !(glowTrack instanceof HTMLElement) ||
        !(sharpTrack instanceof HTMLElement) ||
        bars.length === 0
      ) {
        return { error: "incomplete waveform DOM" };
      }

      const frameRect = frame.getBoundingClientRect();
      const overlayRect = overlay.getBoundingClientRect();
      const logoRect = logo.getBoundingClientRect();
      const leftSloganRect = leftSlogan.getBoundingClientRect();
      const barRects = bars.map((bar) => bar.getBoundingClientRect());
      const tallestBarHeight = Math.max(...barRects.map((bar) => bar.height));
      const topmostBar = Math.min(...barRects.map((bar) => bar.top));
      const blurRadius =
        Math.min(frameRect.width, frameRect.height) *
        waveformModule.WAVEFORM_EDGE_BLUR_MAX_RATIO;
      const blurredBars = Array.from(
        overlay.querySelectorAll(".sound-wave-overlay-blur-bar"),
      );
      const sharpBars = Array.from(
        overlay.querySelectorAll(".sound-wave-overlay-bar"),
      );
      const glowBars = Array.from(
        overlay.querySelectorAll(".sound-wave-overlay-glow-bar"),
      );
      const centerSharpBar = sharpBars[Math.floor(sharpBars.length / 2)];
      const centerIndex = Math.floor(sharpBars.length / 2);
      const edgeBlurBar = blurredBars[0];
      const edgeSharpBar = sharpBars[0];
      const centerGlowBar = glowBars[Math.floor(glowBars.length / 2)];
      const edgeGlowBar = glowBars[0];
      const interiorBlurBar = blurredBars.find((_, index) => {
        const centerDistance =
          Math.abs(index - (blurredBars.length - 1) / 2) /
          ((blurredBars.length - 1) / 2);

        return (
          centerDistance >=
            waveformModule.WAVEFORM_EDGE_BLUR_START_RATIO + 0.08 &&
          centerDistance <=
            waveformModule.WAVEFORM_EDGE_BLUR_START_RATIO + 0.12
        );
      });
      const label = frame.getAttribute("data-format-label");
      const formatDimensions = {
        "1:1": [1080, 1080],
        "3:4": [1080, 1440],
        "4:3": [1440, 1080],
        "9:16": [1080, 1920],
        "16:9": [1920, 1080],
      };
      const [exportWidth, exportHeight] =
        formatDimensions[label] ?? formatDimensions["1:1"];
      const boxScale = Number.parseFloat(
        getComputedStyle(overlay).getPropertyValue(
          "--waveform-style-box-scale",
        ),
      );
      const expectedGeometry = geometryModule.getWaveformGeometry(
        exportWidth,
        exportHeight,
        boxScale,
      );
      const scaleX = frameRect.width / exportWidth;
      const glowBlurRadius =
        Math.min(frameRect.width, frameRect.height) *
        waveformModule.WAVEFORM_GLOW_BLUR_MAX_RATIO;
      const expectedInset =
        sceneGeometryModule.getSceneHorizontalPadding(exportWidth) *
        scaleX;
      const sharpBarRects = sharpBars.map((bar) =>
        bar.getBoundingClientRect(),
      );
      const centerSharpRect = sharpBarRects[centerIndex];
      const expectedBarWidth = expectedGeometry.barWidth * scaleX;
      const maxBarWidthDelta = Math.max(
        ...sharpBarRects.map((rect) =>
          Math.abs(rect.width - expectedBarWidth),
        ),
      );
      const maxBarPositionDelta = Math.max(
        ...sharpBarRects.map((rect, index) =>
          Math.abs(
            rect.left -
              overlayRect.left -
              ((geometryModule.getWaveformBarOffset(
                index,
                expectedGeometry.barStep,
                expectedGeometry.pixelScale,
              ) +
                expectedGeometry.barCenterInset) *
                scaleX -
                rect.width / 2),
          ),
        ),
      );
      const uniformBarWidthDelta = Math.max(
        ...sharpBarRects.map((rect) =>
          Math.abs(rect.width - (sharpBarRects[0]?.width ?? 0)),
        ),
      );
      const capGeometryValid = [...sharpBars, ...blurredBars]
        .filter((bar) => {
          if (!(bar instanceof HTMLElement)) {
            return false;
          }

          return (
            Number.parseFloat(bar.style.opacity || "0") > 0 &&
            bar.getBoundingClientRect().height > 0
          );
        })
        .every((bar) => {
          const rect = bar.getBoundingClientRect();
          const style = getComputedStyle(bar);
          const radius = Number.parseFloat(style.borderTopLeftRadius);

          return (
            style.transform === "none" &&
            rect.height >= rect.width - 0.25 &&
            Number.isFinite(radius) &&
            Math.abs(radius - rect.width / 2) <= 0.25
          );
        });

      const blurFilter = getComputedStyle(blurTrack).filter;
      const actualEdgeBlurRadius = Number.parseFloat(
        blurFilter.match(/blur\(([\d.]+)px\)/)?.[1] ?? "NaN",
      );

      return {
        actualEdgeBlurRadius,
        blurFilter,
        capGeometryValid,
        barCount: sharpBars.length,
        blurredBarCount: blurredBars.length,
        glowBarCount: glowBars.length,
        expectedBarCount: expectedGeometry.barCount,
        centerBarOffset:
          centerSharpRect === undefined
            ? Number.POSITIVE_INFINITY
            : Math.abs(
                centerSharpRect.left +
                  centerSharpRect.width / 2 -
                  (overlayRect.left + overlayRect.width / 2),
              ),
        centerCoreMaskImage:
          centerSharpBar instanceof HTMLElement
            ? getComputedStyle(centerSharpBar).maskImage
            : "none",
        edgeBlurCoreMaskImage:
          edgeBlurBar instanceof HTMLElement
            ? getComputedStyle(edgeBlurBar).maskImage
            : "none",
        centerSharpOpacity: Number.parseFloat(
          centerSharpBar instanceof HTMLElement
            ? centerSharpBar.style.opacity || "0"
            : "0",
        ),
        centerSharpHeight:
          centerSharpBar instanceof HTMLElement
            ? centerSharpBar.getBoundingClientRect().height
            : 0,
        centerGlowHeight:
          centerGlowBar instanceof HTMLElement
            ? centerGlowBar.getBoundingClientRect().height
            : 0,
        centerGlowOpacity: Number.parseFloat(
          centerGlowBar instanceof HTMLElement
            ? centerGlowBar.style.opacity || "0"
            : "0",
        ),
        centerGlowBackground:
          centerGlowBar instanceof HTMLElement
            ? getComputedStyle(centerGlowBar).backgroundImage
            : "none",
        edgeBlurOpacity: Number.parseFloat(
          edgeBlurBar instanceof HTMLElement
            ? edgeBlurBar.style.opacity || "0"
            : "0",
        ),
        edgeSharpOpacity: Number.parseFloat(
          edgeSharpBar instanceof HTMLElement
            ? edgeSharpBar.style.opacity || "0"
            : "0",
        ),
        edgeGlowOpacity: Number.parseFloat(
          edgeGlowBar instanceof HTMLElement
            ? edgeGlowBar.style.opacity || "0"
            : "0",
        ),
        expectedInset,
        expectedEdgeBlurRadius: blurRadius,
        frameHeight: frameRect.height,
        interiorBlurOpacity: Number.parseFloat(
          interiorBlurBar instanceof HTMLElement
            ? interiorBlurBar.style.opacity || "0"
            : "0",
        ),
        label,
        leftInset: overlayRect.left - frameRect.left,
        logoLeftInset: logoRect.left - frameRect.left,
        logoTop: logoRect.top,
        maxBarPositionDelta,
        maxBarWidthDelta,
        rightInset: frameRect.right - overlayRect.right,
        sloganLeftInset: leftSloganRect.left - frameRect.left,
        sharpFilter: getComputedStyle(sharpTrack).filter,
        tallestBarHeight,
        glowFilter: getComputedStyle(glowTrack).filter,
        topWithBlur: Math.min(
          topmostBar - blurRadius * 3,
          ...glowBars.map(
            (bar) =>
              bar.getBoundingClientRect().top - glowBlurRadius * 3,
          ),
        ),
        uniformBarWidthDelta,
      };
      });
    });

    // The analyser attack starts at silence and speech naturally contains
    // short gaps. Validate one internally consistent active-frame snapshot
    // instead of waiting in one browser task and measuring a later frame.
    if (
      result.length > 0 &&
      result.every(
        (format) =>
          !("error" in format) &&
          format.tallestBarHeight >= format.frameHeight * 0.16,
      )
    ) {
      break;
    }

    await page.waitForTimeout(50);
  } while (Date.now() < activeFrameDeadline);

  for (const format of result) {
    if ("error" in format) {
      throw new Error(`${viewportName} waveform extent: ${format.error}`);
    }

    if (
      Math.abs(format.leftInset - format.expectedInset) > 0.8 ||
      Math.abs(format.rightInset - format.expectedInset) > 0.8 ||
      Math.abs(format.logoLeftInset - format.expectedInset) > 0.8 ||
      Math.abs(format.sloganLeftInset - format.expectedInset) > 0.8
    ) {
      throw new Error(
        `${viewportName} ${format.label} composition guides diverged: ` +
          JSON.stringify(format),
      );
    }

    if (
      format.barCount !== format.expectedBarCount ||
      format.blurredBarCount !== format.expectedBarCount ||
      format.glowBarCount !== format.expectedBarCount ||
      format.barCount % 2 !== 1 ||
      format.centerBarOffset > 0.25
    ) {
      throw new Error(
        `${viewportName} ${format.label} odd center geometry is incorrect: ` +
          JSON.stringify(format),
      );
    }

    if (
      format.blurFilter === "none" ||
      !Number.isFinite(format.actualEdgeBlurRadius) ||
      Math.abs(
        format.actualEdgeBlurRadius - format.expectedEdgeBlurRadius,
      ) > 0.25 ||
      format.glowFilter === "none" ||
      !format.capGeometryValid ||
      format.sharpFilter !== "none" ||
      format.edgeBlurOpacity < 0.01 ||
      format.edgeSharpOpacity < 0.005 ||
      format.edgeBlurOpacity <= format.edgeSharpOpacity * 2 ||
      format.centerGlowHeight <= format.centerSharpHeight ||
      format.centerGlowOpacity < 0.08 ||
      format.centerGlowOpacity > 0.21 ||
      !format.centerGlowBackground.includes("32%") ||
      !format.centerGlowBackground.includes("68%") ||
      format.edgeGlowOpacity <= 0 ||
      format.edgeGlowOpacity >= format.centerGlowOpacity ||
      format.interiorBlurOpacity <= 0.005 ||
      format.centerSharpOpacity < 0.9 ||
      format.centerCoreMaskImage !== "none" ||
      format.edgeBlurCoreMaskImage !== "none"
    ) {
      throw new Error(
        `${viewportName} ${format.label} edge blur is incorrect: ${JSON.stringify(format)}`,
      );
    }

    if (
      format.maxBarPositionDelta > 0.35 ||
      format.maxBarWidthDelta > 0.25 ||
      format.uniformBarWidthDelta > 0.03
    ) {
      throw new Error(
        `${viewportName} ${format.label} waveform columns are not uniform: ` +
          JSON.stringify(format),
      );
    }

    if (format.topWithBlur < format.logoTop - 1) {
      throw new Error(
        `${viewportName} ${format.label} waveform crossed the logo boundary: ` +
          `${format.topWithBlur} < ${format.logoTop}`,
      );
    }

    if (format.tallestBarHeight < format.frameHeight * 0.16) {
      throw new Error(
        `${viewportName} ${format.label} waveform collapsed too low: ` +
          `${format.tallestBarHeight}/${format.frameHeight}`,
      );
    }
  }
}

async function verifyWaveformAmplitudeProfile(page) {
  const result = await page.evaluate(async () => {
    const geometryModule = await import("/src/lib/waveformGeometry.ts");
    const waveformModule = await import("/src/lib/waveformBars.ts");
    const spectrumModule = await import("/src/lib/audioSpectrum.ts");
    const spectrum = new Float32Array(
      spectrumModule.AUDIO_SPECTRUM_BAND_COUNT,
    );
    const voiceBand =
      (Math.log(
        spectrumModule.AUDIO_WAVEFORM_MIN_FREQUENCY_HZ /
          spectrumModule.AUDIO_SPECTRUM_MIN_FREQUENCY_HZ,
      ) /
        Math.log(
          spectrumModule.AUDIO_SPECTRUM_MAX_FREQUENCY_HZ /
            spectrumModule.AUDIO_SPECTRUM_MIN_FREQUENCY_HZ,
        )) *
      spectrum.length;

    for (
      let index = Math.max(0, Math.floor(voiceBand) - 1);
      index <= Math.min(spectrum.length - 1, Math.ceil(voiceBand) + 1);
      index += 1
    ) {
      spectrum[index] = 1;
    }

    const style = waveformModule.getWaveformStyle();
    const bars = waveformModule.createWaveformBars(
      spectrum,
      style,
      { timestampSeconds: 0.7 },
    );
    const centerIndex = Math.floor(bars.length / 2);
    const half = bars.slice(centerIndex).map((bar) => bar.heightRatio);
    const flatBars = waveformModule.createWaveformBars(
      new Float32Array(spectrum.length).fill(0.4),
      style,
      { timestampSeconds: 0.7 },
    );
    const silence = waveformModule.createWaveformBars(
      new Float32Array(spectrum.length),
      style,
      { timestampSeconds: 0.7 },
    );
    const dynamicSpectrum = new Float32Array(spectrum.length);

    for (let index = 0; index < dynamicSpectrum.length; index += 1) {
      dynamicSpectrum[index] =
        0.12 +
        0.76 *
          (0.5 +
            0.5 *
              Math.sin(index * 1.71 + Math.sin(index * 0.37)));
    }

    const dynamicBars = waveformModule.createWaveformBars(
      dynamicSpectrum,
      style,
      { timestampSeconds: 0.7 },
    );
    const dynamicHalf = dynamicBars
      .slice(Math.floor(dynamicBars.length / 2))
      .map((bar) => bar.heightRatio);
    const dynamicPeak = Math.max(...dynamicHalf, Number.EPSILON);
    const normalizedDynamicVariation =
      dynamicHalf
        .slice(1)
        .reduce(
          (variation, height, index) =>
            variation +
            Math.abs(height - (dynamicHalf[index] ?? height)),
          0,
        ) /
      Math.max(1, dynamicHalf.length - 1) /
      dynamicPeak;
    const decayPeakRatios = [
      0.1,
      0.08,
      0.06,
      0.04,
      0.02,
      0.01,
      0.005,
      0.0025,
    ];
    const decayPeakHeights = decayPeakRatios.map((peakHeightRatio) => {
      const amplitudeScale = geometryModule.getWaveformAmplitudeScale(
        1080,
        1080,
        320,
        peakHeightRatio,
        waveformModule.WAVEFORM_AMPLITUDE_SCALE,
        1080 * waveformModule.WAVEFORM_EDGE_BLUR_MAX_RATIO,
      );

      return peakHeightRatio * 320 * amplitudeScale;
    });
    const decayHasNoPlateau = decayPeakHeights
      .slice(1)
      .every(
        (height, index) =>
          height <
          (decayPeakHeights[index] ?? Number.POSITIVE_INFINITY) *
          0.995,
    );
    const loudSpectrum = new Float32Array(spectrum.length).fill(0.8);
    const starStyle = {
      ...style,
      useStarProfile: true,
    };
    const deterministicA = waveformModule.createWaveformBars(
      dynamicSpectrum,
      starStyle,
      { timestampSeconds: 0.7 },
    );
    const deterministicB = waveformModule.createWaveformBars(
      dynamicSpectrum,
      starStyle,
      { timestampSeconds: 0.7 },
    );
    const movedBars = waveformModule.createWaveformBars(
      dynamicSpectrum,
      starStyle,
      { timestampSeconds: 0.82 },
    );
    const getPairMeans = (profile) => {
      const profileCenterIndex = (profile.length - 1) / 2;

      return Array.from(
        { length: profileCenterIndex + 1 },
        (_, offset) => {
          if (offset === 0) {
            return profile[profileCenterIndex]?.heightRatio ?? 0;
          }

          return (
            ((profile[profileCenterIndex - offset]?.heightRatio ?? 0) +
              (profile[profileCenterIndex + offset]?.heightRatio ?? 0)) /
            2
          );
        },
      );
    };
    const getPairDeltas = (profile) => {
      const profileCenterIndex = (profile.length - 1) / 2;
      const profilePeak = Math.max(
        Number.EPSILON,
        ...profile.map((bar) => bar.heightRatio),
      );

      return Array.from(
        { length: profileCenterIndex },
        (_, pairIndex) => {
          const offset = pairIndex + 1;
          const left =
            profile[profileCenterIndex - offset]?.heightRatio ?? 0;
          const right =
            profile[profileCenterIndex + offset]?.heightRatio ?? 0;
          const pairMean = (left + right) / 2;

          return (
            Math.abs(left - right) /
            Math.max(profilePeak * 0.05, pairMean)
          );
        },
      );
    };
    const getEnvelopeZones = (profile) => {
      const pairs = getPairMeans(profile);
      const averageRange = (minimum, maximum) => {
        const values = pairs.filter((_, index) => {
          const distance = index / Math.max(1, pairs.length - 1);

          return distance >= minimum && distance <= maximum;
        });

        return (
          values.reduce((sum, value) => sum + value, 0) /
          Math.max(1, values.length)
        );
      };

      return {
        center: pairs[0] ?? 0,
        edge: averageRange(0.82, 1),
        inner: averageRange(0, 0.2),
        shoulder: averageRange(0.38, 0.62),
      };
    };
    const dynamicPairDeltas = getPairDeltas(deterministicA);
    const meanDynamicPairDelta =
      dynamicPairDeltas.reduce((sum, value) => sum + value, 0) /
      Math.max(1, dynamicPairDeltas.length);
    const maximumDynamicPairDelta = Math.max(
      0,
      ...dynamicPairDeltas,
    );
    const deterministic =
      deterministicA.length === deterministicB.length &&
      deterministicA.every((bar, index) => {
        const comparison = deterministicB[index];

        return (
          Math.abs(
            bar.heightRatio - (comparison?.heightRatio ?? -1),
          ) < 1e-12 &&
          Math.abs(bar.opacity - (comparison?.opacity ?? -1)) <
            1e-12 &&
          Math.abs(
            bar.blurProgress - (comparison?.blurProgress ?? -1),
          ) < 1e-12
        );
      });
    const motionChanged = deterministicA.some((bar, index) => {
      const center = (deterministicA.length - 1) / 2;

      return (
        index !== center &&
        Math.abs(
          bar.heightRatio -
            (movedBars[index]?.heightRatio ?? bar.heightRatio),
        ) > 1e-5
      );
    });
    const motionPeak = Math.max(
      Number.EPSILON,
      ...deterministicA.map((bar) => bar.heightRatio),
    );
    const maximumMotionDelta =
      Math.max(
        0,
        ...deterministicA.map((bar, index) =>
          Math.abs(
            bar.heightRatio -
              (movedBars[index]?.heightRatio ?? bar.heightRatio),
          ),
        ),
      ) / motionPeak;
    const flatEnvelope = getEnvelopeZones(flatBars);
    const movedEnvelope = getEnvelopeZones(movedBars);
    const oddCountProfiles = [65, 49, 41].map((barCount) => {
      const profile = waveformModule.createWaveformBars(
        loudSpectrum,
        starStyle,
        { barCount, timestampSeconds: 0.7 },
      );
      const profileCenterIndex = (profile.length - 1) / 2;
      const center = profile[profileCenterIndex];
      const leftNeighbor = profile[profileCenterIndex - 1];
      const rightNeighbor = profile[profileCenterIndex + 1];
      const pairDeltas = getPairDeltas(profile);
      const pairMeans = getPairMeans(profile);

      return {
        barCount: profile.length,
        centralSevenElevated:
          pairMeans
            .slice(1, 4)
            .every(
              (height, index) =>
                height < (pairMeans[index] ?? 0),
            ) &&
          (pairMeans[3] ?? 0) > (pairMeans[4] ?? 0) * 1.02,
        centerIsUnique:
          Number.isInteger(profileCenterIndex) &&
          center !== undefined &&
          leftNeighbor !== undefined &&
          rightNeighbor !== undefined &&
          center.blurProgress === 0 &&
          center.heightRatio > leftNeighbor.heightRatio &&
          center.heightRatio > rightNeighbor.heightRatio,
        hasNaturalAsymmetry:
          pairDeltas.filter((delta) => delta > 0.005).length >=
          Math.ceil(pairDeltas.length * 0.2),
        radialStyleBalanced: profile.every((bar, index) => {
          const mirror = profile[profile.length - 1 - index];

          return (
            Math.abs(bar.opacity - (mirror?.opacity ?? -1)) < 1e-12 &&
            Math.abs(
              bar.blurProgress - (mirror?.blurProgress ?? -1),
            ) < 1e-12
          );
        }),
      };
    });
    const interiorBlurBar = bars.find((_, index) => {
      const centerDistance =
        Math.abs(index - (bars.length - 1) / 2) /
        ((bars.length - 1) / 2);

      return (
        centerDistance >=
          waveformModule.WAVEFORM_EDGE_BLUR_START_RATIO + 0.08 &&
        centerDistance <=
          waveformModule.WAVEFORM_EDGE_BLUR_START_RATIO + 0.12
      );
    });

    return {
      activeEdgeHeight: half.at(-1) ?? 0,
      allFiniteAndBounded: bars.every(
        (bar) =>
          Number.isFinite(bar.heightRatio) &&
          bar.heightRatio >= 0 &&
          bar.heightRatio <= 1.65,
      ),
      blurFiniteAndBounded: bars.every(
        (bar) =>
          Number.isFinite(bar.blurProgress) &&
          bar.blurProgress >= 0 &&
          bar.blurProgress <= 1,
      ),
      blurProgressesCenterOut: bars
        .slice(bars.length / 2)
        .every(
          (bar, index, halfBars) =>
            index === 0 ||
            bar.blurProgress >=
              (halfBars[index - 1]?.blurProgress ?? 1) - 1e-8,
        ),
      decayHasNoPlateau,
      decayPeakHeights,
      deterministic,
      centerSharp:
        (bars[Math.floor(bars.length / 2)]?.blurProgress ?? 1) <= 0.01,
      edgeBlurred: (bars.at(-1)?.blurProgress ?? 0) >= 0.99,
      edgeOpacity: bars.at(-1)?.opacity ?? 0,
      edgeSharpCore:
        waveformModule.getWaveformBarLayerOpacities(bars.at(-1))
          .sharpOpacity > 0,
      interiorBlurVisible:
        (interiorBlurBar?.blurProgress ?? 0) > 0 &&
        waveformModule.getWaveformBarLayerOpacities(
          interiorBlurBar ?? {
            blurProgress: 0,
            opacity: 0,
          },
        ).blurOpacity > 0,
      flatEnvelope,
      hasNaturalAsymmetry:
        dynamicPairDeltas.filter((delta) => delta > 0.005).length >=
        Math.ceil(dynamicPairDeltas.length * 0.2),
      maximumDynamicPairDelta,
      maximumMotionDelta,
      meanDynamicPairDelta,
      motionChanged,
      movedEnvelope,
      normalizedDynamicVariation,
      oddCountProfiles,
      silencePeak: Math.max(...silence.map((bar) => bar.heightRatio)),
    };
  });

  if (
    result.activeEdgeHeight <= 0 ||
    !result.allFiniteAndBounded ||
    !result.blurFiniteAndBounded ||
    !result.blurProgressesCenterOut ||
    !result.decayHasNoPlateau ||
    !result.deterministic ||
    !result.centerSharp ||
    !result.edgeBlurred ||
    !result.edgeSharpCore ||
    !result.interiorBlurVisible ||
    result.hasNaturalAsymmetry ||
    result.meanDynamicPairDelta > 1e-8 ||
    result.maximumDynamicPairDelta > 1e-8 ||
    result.motionChanged ||
    result.maximumMotionDelta > 1e-8 ||
    result.flatEnvelope.center <= result.flatEnvelope.inner * 1.03 ||
    result.flatEnvelope.inner <= result.flatEnvelope.shoulder * 1.25 ||
    result.flatEnvelope.shoulder <= result.flatEnvelope.edge * 1.5 ||
    result.movedEnvelope.inner <= result.movedEnvelope.edge * 1.5 ||
    result.normalizedDynamicVariation < 0.035 ||
    result.edgeOpacity < 0.1 ||
    result.oddCountProfiles.some(
      (profile) =>
        profile.barCount % 2 !== 1 ||
        !profile.centralSevenElevated ||
        !profile.centerIsUnique ||
        profile.hasNaturalAsymmetry ||
        !profile.radialStyleBalanced,
    ) ||
    result.silencePeak !== 0
  ) {
    throw new Error(
      `Waveform amplitude profile regression: ${JSON.stringify(result)}`,
    );
  }
}

async function verifyWaveformCapsuleHeight(page) {
  const result = await page.evaluate(async () => {
    const {
      WAVEFORM_DEFAULT_BAR_COUNT,
      WAVEFORM_NINE_BY_SIXTEEN_BAR_COUNT,
      WAVEFORM_THREE_BY_FOUR_BAR_COUNT,
      getWaveformBarOffset,
      getWaveformGeometry,
      getWaveformGlowHeight,
      getWaveformRenderedBarHeight,
      getWaveformRenderedBarOpacityScale,
      getWaveformRenderedBarWidth,
    } = await import(
      "/src/lib/waveformGeometry.ts"
    );
    const heightCases = [
      {
        actual: getWaveformRenderedBarHeight(0, 100, 4, 5),
        expected: 0,
        label: "silence",
      },
      {
        actual: getWaveformRenderedBarHeight(0.001, 100, 1, 5),
        expected: 0.1,
        label: "sub-width active",
      },
      {
        actual: getWaveformRenderedBarHeight(0.05, 100, 1, 5),
        expected: 5,
        label: "exact-width active",
      },
      {
        actual: getWaveformRenderedBarHeight(0.02, 100, 4, 5),
        expected: 8,
        label: "tall active",
      },
    ].map((testCase) => ({
      ...testCase,
      pass: Math.abs(testCase.actual - testCase.expected) < 1e-8,
    }));
    const gridCases = [
      [1080, 1080],
      [1080, 1440],
      [1440, 1080],
      [1080, 1920],
      [1920, 1080],
    ].map(([width, height]) => {
      const geometry = getWaveformGeometry(width, height);
      const offsets = Array.from(
        { length: geometry.barCount },
        (_, index) =>
          getWaveformBarOffset(
            index,
            geometry.barStep,
            geometry.pixelScale,
          ),
      );
      const doubledGeometry = getWaveformGeometry(
        width * 2,
        height * 2,
        1,
        2,
      );
      const doubledOffsets = Array.from(
        { length: doubledGeometry.barCount },
        (_, index) =>
          getWaveformBarOffset(
            index,
            doubledGeometry.barStep,
            doubledGeometry.pixelScale,
          ),
      );
      const gaps = offsets
        .slice(1)
        .map(
          (offset, index) =>
            offset - (offsets[index] ?? 0) - geometry.barWidth,
        );

      return {
        absolutePixelAligned: offsets.every((offset) =>
          Number.isInteger(
            (width - geometry.width) / 2 +
              offset +
              geometry.barCenterInset,
          ),
        ),
        barWidth: geometry.barWidth,
        barCount: geometry.barCount,
        centerIsExact: (() => {
          const centerIndex = (geometry.barCount - 1) / 2;

          return (
            offsets[centerIndex] + geometry.barCenterInset ===
            geometry.width / 2
          );
        })(),
        doubledAbsolutePixelAligned: doubledOffsets.every((offset) =>
          Number.isInteger(
            (width * 2 - doubledGeometry.width) / 2 +
              offset +
              doubledGeometry.barCenterInset,
          ),
        ),
        exactCenters:
          offsets[0] + geometry.barCenterInset ===
            geometry.gridBarWidth / 2 &&
          (offsets.at(-1) ?? -1) + geometry.barCenterInset ===
            geometry.width - geometry.gridBarWidth / 2,
        exactHalfWidth:
          geometry.barWidth * 2 === geometry.gridBarWidth &&
          geometry.barCenterInset * 2 === geometry.gridBarWidth,
        exactTwoX:
          doubledGeometry.barWidth === geometry.barWidth * 2 &&
          doubledGeometry.barCenterInset ===
            geometry.barCenterInset * 2 &&
          doubledGeometry.gridBarWidth === geometry.gridBarWidth * 2 &&
          doubledGeometry.width === geometry.width * 2 &&
          Math.abs(doubledGeometry.height - geometry.height * 2) < 1e-8 &&
          doubledOffsets.every(
            (offset, index) => offset === (offsets[index] ?? -1) * 2,
          ),
        gapsDifferByAtMostOnePixel:
          Math.max(...gaps) - Math.min(...gaps) <= 1,
        height,
        integerBarWidth: Number.isInteger(geometry.barWidth),
        integerOffsets: offsets.every(Number.isInteger),
        width,
      };
    });
    const expectedCounts = [
      WAVEFORM_DEFAULT_BAR_COUNT,
      WAVEFORM_THREE_BY_FOUR_BAR_COUNT,
      WAVEFORM_DEFAULT_BAR_COUNT,
      WAVEFORM_NINE_BY_SIXTEEN_BAR_COUNT,
      WAVEFORM_DEFAULT_BAR_COUNT,
    ];
    const densityPolicyValid =
      gridCases.every(
        (gridCase, index) =>
          gridCase.barCount === expectedCounts[index] &&
          gridCase.barCount % 2 === 1 &&
          gridCase.centerIsExact,
      ) &&
      gridCases[1].barWidth > gridCases[0].barWidth &&
      gridCases[3].barWidth >= gridCases[1].barWidth;
    const opacityFade = [0.05, 0.04, 0.02, 0].map(
      (heightRatio) =>
        getWaveformRenderedBarOpacityScale(
          heightRatio,
          100,
          1,
          5,
        ),
    );
    const quietCircleHeights = [0.04, 0.02, 0.01].map(
      (heightRatio) =>
        getWaveformRenderedBarHeight(
          heightRatio,
          100,
          1,
          5,
        ),
    );
    const quietCircleWidths = quietCircleHeights.map((height) =>
      getWaveformRenderedBarWidth(height, 5),
    );
    const glowHeight = getWaveformGlowHeight(20, 100, 1, 80);

    return {
      glowHeight,
      gridCases,
      heightCases,
      densityPolicyValid,
      opacityFade,
      quietCircleHeights,
      quietCircleWidths,
    };
  });

  const failedHeightCase = result.heightCases.find(
    (testCase) => !testCase.pass,
  );

  if (failedHeightCase) {
    throw new Error(
      `Waveform capsule height regression: ${JSON.stringify(failedHeightCase)}`,
    );
  }

  if (
    result.opacityFade.some(
      (opacity, index, values) =>
        opacity < 0 ||
        opacity > 1 ||
        (index > 0 && opacity >= (values[index - 1] ?? 0)),
    )
  ) {
    throw new Error(
      `Waveform capsule fade regression: ${JSON.stringify(result.opacityFade)}`,
    );
  }

  if (
    result.glowHeight <= 20 ||
    result.glowHeight > 80 ||
    result.quietCircleHeights.some(
      (height, index) =>
        Math.abs(height - (result.quietCircleWidths[index] ?? -1)) >
        1e-8,
    )
  ) {
    throw new Error(
      `Waveform quiet-circle/glow regression: ${JSON.stringify({
        glowHeight: result.glowHeight,
        heights: result.quietCircleHeights,
        widths: result.quietCircleWidths,
      })}`,
    );
  }

  const failedGridCase = result.gridCases.find(
    (testCase) =>
      !testCase.absolutePixelAligned ||
      !testCase.doubledAbsolutePixelAligned ||
      !testCase.centerIsExact ||
      !testCase.exactCenters ||
      !testCase.exactHalfWidth ||
      !testCase.exactTwoX ||
      !testCase.gapsDifferByAtMostOnePixel ||
      !testCase.integerBarWidth ||
      !testCase.integerOffsets,
  );

  if (failedGridCase) {
    throw new Error(
      `Waveform pixel grid regression: ${JSON.stringify(failedGridCase)}`,
    );
  }

  if (!result.densityPolicyValid) {
    throw new Error(
      `Waveform density policy regression: ${JSON.stringify(result.gridCases)}`,
    );
  }
}

async function verifyBlobChainMapping(page) {
  const result = await page.evaluate(async () => {
    const { createShaderBlobChain } = await import(
      "/src/lib/shaderBlobChain.ts"
    );
    const blobs = [
      {
        bend: -1.2,
        color: "#5666cf",
        id: "blob-a",
        name: "Anchor 1",
        opacity: 0.92,
        rotation: -0.02,
        size: 1.85,
        stretch: 2.8,
        taper: 0.02,
        x: 0.23,
        y: 0.52,
      },
      {
        bend: -0.23,
        color: "#ff9a4d",
        id: "blob-b",
        name: "Anchor 2",
        opacity: 0.86,
        rotation: 0.02,
        size: 0.88,
        stretch: 3,
        taper: 0.29,
        x: 0.47,
        y: 0.51,
      },
      {
        bend: 0.24,
        color: "#eeeeee",
        id: "blob-c",
        name: "Anchor 3",
        opacity: 0.85,
        rotation: 0.01,
        size: 0.3,
        stretch: 2.7,
        taper: 0.06,
        x: 0.78,
        y: 0.53,
      },
    ];
    const chain = createShaderBlobChain(blobs);
    const mutations = [
      ["x", 1],
      ["y", 0],
      ["size", 0.08],
      ["stretch", 0.35],
      ["rotation", 0.7],
      ["bend", 1.2],
      ["taper", -0.95],
      ["opacity", 0],
    ];
    const mutationResults = mutations.map(([field, value]) => {
      const nextBlobs = blobs.map((blob, index) =>
        index === 0 ? { ...blob, [field]: value } : { ...blob },
      );
      const nextChain = createShaderBlobChain(nextBlobs);

      return {
        changed: [0, 3, 6].every(
          (index) => nextChain[index][field] !== chain[index][field],
        ),
        field,
      };
    });
    const extremeChains = [0, 1].map((x) =>
      createShaderBlobChain(blobs.map((blob) => ({ ...blob, x }))),
    );

    return {
      allActive: chain.every((blob) => blob.opacity > 0),
      ids: chain.map((blob) => blob.id),
      length: chain.length,
      monotonicAtExtremes: extremeChains.every((candidate) =>
        candidate.every(
          (blob, index) =>
            index === 0 || blob.x > candidate[index - 1].x,
        ),
      ),
      mutationResults,
      xPositions: chain.map((blob) => blob.x),
    };
  });
  const expectedIds = [
    "blob-a-shader-0",
    "blob-b-shader-1",
    "blob-c-shader-2",
    "blob-a-shader-3",
    "blob-b-shader-4",
    "blob-c-shader-5",
    "blob-a-shader-6",
    "blob-b-shader-7",
  ];

  if (
    result.length !== 8 ||
    !result.allActive ||
    !result.monotonicAtExtremes ||
    JSON.stringify(result.ids) !== JSON.stringify(expectedIds) ||
    result.mutationResults.some(({ changed }) => !changed)
  ) {
    throw new Error(
      `Shader blob chain regression: ${JSON.stringify(result)}`,
    );
  }

  result.xPositions.forEach((x, index) => {
    const expectedX = 0.1 + (index / 7) * 0.8;

    if (Math.abs(x - expectedX) > 1e-9) {
      throw new Error(
        `Shader blob chain baseline x mismatch at ${index}: ${x}`,
      );
    }
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

async function installIsolatedGalleryApi(
  page,
  initialGalleryState,
  { injectConcurrentSection = false } = {},
) {
  let galleryState = cloneJson(initialGalleryState);
  let galleryRevisionNumber = 0;
  let hasInjectedConcurrentSection = false;
  const getGalleryRevision = () => `"isolated-${galleryRevisionNumber}"`;

  await page.route("**/api/gallery", async (route) => {
    const request = route.request();

    if (request.method() === "GET") {
      await route.fulfill({
        body: JSON.stringify(galleryState),
        contentType: "application/json",
        headers: {
          "Cache-Control": "no-store",
          ETag: getGalleryRevision(),
        },
        status: 200,
      });
      return;
    }

    if (request.method() === "PUT") {
      try {
        const expectedRevision = request.headers()["if-match"];

        if (!expectedRevision) {
          await route.fulfill({
            body: JSON.stringify({ error: "If-Match is required." }),
            contentType: "application/json",
            headers: { ETag: getGalleryRevision() },
            status: 428,
          });
          return;
        }

        if (injectConcurrentSection && !hasInjectedConcurrentSection) {
          galleryState = {
            ...galleryState,
            sections: [
              ...galleryState.sections,
              {
                id: "concurrent-remote-section",
                isOpen: true,
                name: "Concurrent remote",
              },
            ],
          };
          galleryRevisionNumber += 1;
          hasInjectedConcurrentSection = true;
        }

        if (expectedRevision !== getGalleryRevision()) {
          await route.fulfill({
            body: JSON.stringify({
              error: "Gallery state changed.",
              state: galleryState,
            }),
            contentType: "application/json",
            headers: { ETag: getGalleryRevision() },
            status: 409,
          });
          return;
        }

        const nextGalleryState = JSON.parse(request.postData() ?? "");

        if (
          !nextGalleryState ||
          !Array.isArray(nextGalleryState.items) ||
          !Array.isArray(nextGalleryState.sections)
        ) {
          throw new Error("Invalid isolated gallery state.");
        }

        galleryState = cloneJson(nextGalleryState);
        galleryRevisionNumber += 1;
        await route.fulfill({
          body: JSON.stringify({ ok: true, state: galleryState }),
          contentType: "application/json",
          headers: { ETag: getGalleryRevision() },
          status: 200,
        });
      } catch (error) {
        await route.fulfill({
          body: JSON.stringify({
            error: error instanceof Error ? error.message : "Invalid JSON.",
          }),
          contentType: "application/json",
          status: 400,
        });
      }

      return;
    }

    await route.fulfill({
      body: JSON.stringify({ error: "Method not allowed." }),
      contentType: "application/json",
      headers: { Allow: "GET, PUT" },
      status: 405,
    });
  });

  return () => cloneJson(galleryState);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
