import {
  getSceneContentWidth,
} from "./sceneGeometry";

export const WAVEFORM_DEFAULT_BAR_COUNT = 65;
export const WAVEFORM_THREE_BY_FOUR_BAR_COUNT = 49;
export const WAVEFORM_NINE_BY_SIXTEEN_BAR_COUNT = 41;
export const WAVEFORM_BAR_WIDTH_REFERENCE = 2;
export const WAVEFORM_BAR_GAP_REFERENCE = 7;
export const WAVEFORM_TRACK_WIDTH_REFERENCE =
  WAVEFORM_DEFAULT_BAR_COUNT * WAVEFORM_BAR_WIDTH_REFERENCE +
  (WAVEFORM_DEFAULT_BAR_COUNT - 1) * WAVEFORM_BAR_GAP_REFERENCE;
const WAVEFORM_VISIBLE_BAR_WIDTH_SCALE = 0.5;
const WAVEFORM_THREE_BY_FOUR_WIDTH_SCALE = 1.55;
const WAVEFORM_NINE_BY_SIXTEEN_WIDTH_SCALE = 1.65;

export function getWaveformGeometry(
  width: number,
  height: number,
  boxScale = 1,
  pixelScale = 1,
) {
  const safeWidth = Math.max(1, finiteOr(width, 1));
  const safeHeight = Math.max(1, finiteOr(height, 1));
  const safeScale = Math.max(0.05, finiteOr(boxScale, 1));
  const safePixelScale = Math.max(
    1,
    Math.round(finiteOr(pixelScale, 1)),
  );
  const logicalWidth = safeWidth / safePixelScale;
  const logicalHeight = safeHeight / safePixelScale;
  const ratio = logicalWidth / logicalHeight;
  const barCount = getWaveformBarCount(safeWidth, safeHeight);
  const waveformHeightScale = getWaveformHeightScale(ratio);
  const logicalContentWidth =
    getSceneContentWidth(safeWidth, safePixelScale) / safePixelScale;
  const unit =
    logicalContentWidth / WAVEFORM_TRACK_WIDTH_REFERENCE;
  const idealGridBarWidth =
    WAVEFORM_BAR_WIDTH_REFERENCE *
    unit *
    getWaveformBarWidthScale(ratio);
  const idealTrackWidth = logicalContentWidth;
  const logicalTrackWidth = roundToMatchingParity(
    Math.max(
      barCount,
      idealTrackWidth,
    ),
    Math.round(logicalWidth),
    barCount,
  );
  // Preserve the established bar-centre grid, then make only the visible
  // capsule exactly half as wide. Keeping this in logical pixels makes 2×
  // output an exact scale-up of 1×, including odd 3 px portrait columns.
  const logicalGridBarWidth = Math.min(
    roundToMatchingParity(
      idealGridBarWidth,
      logicalTrackWidth,
      1,
    ),
    Math.floor(logicalTrackWidth / barCount),
  );
  const logicalBarWidth =
    logicalGridBarWidth * WAVEFORM_VISIBLE_BAR_WIDTH_SCALE;
  const logicalBarCenterInset = logicalGridBarWidth / 2;
  const logicalBarStep =
    (logicalTrackWidth - logicalGridBarWidth) /
    Math.max(barCount - 1, 1);
  const trackWidth = logicalTrackWidth * safePixelScale;
  const barWidth = logicalBarWidth * safePixelScale;
  const barCenterInset = logicalBarCenterInset * safePixelScale;
  const barStep = logicalBarStep * safePixelScale;

  return {
    barCount,
    barCenterInset,
    barWidth,
    barStep,
    gridBarWidth: logicalGridBarWidth * safePixelScale,
    height: safeHeight * 0.32 * waveformHeightScale * safeScale,
    pixelScale: safePixelScale,
    width: trackWidth,
  };
}

export function getWaveformBarCount(
  width: number,
  height: number,
) {
  const safeWidth = Math.max(1, finiteOr(width, 1));
  const safeHeight = Math.max(1, finiteOr(height, 1));
  const ratio = safeWidth / safeHeight;

  if (isRatio(ratio, 9 / 16)) {
    return WAVEFORM_NINE_BY_SIXTEEN_BAR_COUNT;
  }

  if (isRatio(ratio, 3 / 4)) {
    return WAVEFORM_THREE_BY_FOUR_BAR_COUNT;
  }

  return WAVEFORM_DEFAULT_BAR_COUNT;
}

export function getWaveformBarOffset(
  index: number,
  barStep: number,
  pixelScale = 1,
) {
  const safeIndex = Math.max(0, Math.round(finiteOr(index, 0)));
  const safeStep = Math.max(0, finiteOr(barStep, 0));
  const safePixelScale = Math.max(
    1,
    Math.round(finiteOr(pixelScale, 1)),
  );

  // Pixel-snap every bar independently. The sub-pixel remainder is spread
  // across the gaps, while HiDPI/PNG output stays an exact multiple of the
  // canonical 1× grid.
  return (
    Math.round((safeIndex * safeStep) / safePixelScale) *
    safePixelScale
  );
}

export function getWaveformAmplitudeScale(
  width: number,
  height: number,
  overlayHeight: number,
  peakHeightRatio: number,
  baseAmplitudeScale: number,
  edgeBlurRadius = 0,
) {
  const safeWidth = Math.max(1, finiteOr(width, 1));
  const safeHeight = Math.max(1, finiteOr(height, 1));
  const safeOverlayHeight = Math.max(1, finiteOr(overlayHeight, 1));
  const safePeak = Math.max(0, finiteOr(peakHeightRatio, 0));
  const safeBaseScale = Math.max(0, finiteOr(baseAmplitudeScale, 0));
  const safeEdgeBlurRadius = Math.max(0, finiteOr(edgeBlurRadius, 0));

  if (safePeak <= Number.EPSILON) {
    return safeBaseScale;
  }

  const maxPeakHeight = getWaveformMaxPeakHeight(
    safeWidth,
    safeHeight,
    safeEdgeBlurRadius,
  );
  const basePeakHeight = safePeak * safeOverlayHeight * safeBaseScale;
  const compression = basePeakHeight / maxPeakHeight;
  const targetPeakHeight =
    basePeakHeight /
    (1 + compression ** 4) ** 0.25;

  return targetPeakHeight / (safePeak * safeOverlayHeight);
}

export function getWaveformRenderedBarHeight(
  heightRatio: number,
  overlayHeight: number,
  amplitudeScale: number,
  barWidth: number,
) {
  const safeHeightRatio = Math.max(0, finiteOr(heightRatio, 0));

  if (safeHeightRatio <= Number.EPSILON) {
    return 0;
  }

  const safeOverlayHeight = Math.max(0, finiteOr(overlayHeight, 0));
  const safeAmplitudeScale = Math.max(0, finiteOr(amplitudeScale, 0));
  void barWidth;
  return safeHeightRatio * safeOverlayHeight * safeAmplitudeScale;
}

export function getWaveformRenderedBarCenterOffset(
  centerOffsetRatio: number,
  overlayHeight: number,
  amplitudeScale: number,
) {
  const safeOffset = finiteOr(centerOffsetRatio, 0);
  const safeOverlayHeight = Math.max(0, finiteOr(overlayHeight, 0));
  const scaleMix = Math.min(
    1,
    Math.max(0.35, finiteOr(amplitudeScale, 0) / 4),
  );

  return safeOffset * safeOverlayHeight * scaleMix;
}

export function getWaveformRenderedBarWidth(
  renderedBarHeight: number,
  barWidth: number,
) {
  return Math.max(
    0,
    Math.min(
      finiteOr(renderedBarHeight, 0),
      Math.max(0, finiteOr(barWidth, 0)),
    ),
  );
}

export function getWaveformRenderedBarOpacityScale(
  heightRatio: number,
  overlayHeight: number,
  amplitudeScale: number,
  barWidth: number,
) {
  const rawHeight =
    Math.max(0, finiteOr(heightRatio, 0)) *
    Math.max(0, finiteOr(overlayHeight, 0)) *
    Math.max(0, finiteOr(amplitudeScale, 0));
  const safeBarWidth = Math.max(
    Number.EPSILON,
    finiteOr(barWidth, 0),
  );

  return Math.max(0, Math.min(1, rawHeight / safeBarWidth));
}

export function getWaveformGlowHeight(
  renderedBarHeight: number,
  overlayHeight: number,
  activityOpacity: number,
  maxHeight = Number.POSITIVE_INFINITY,
) {
  const safeBarHeight = Math.max(
    0,
    finiteOr(renderedBarHeight, 0),
  );

  if (safeBarHeight <= Number.EPSILON) {
    return 0;
  }

  const safeOverlayHeight = Math.max(
    0,
    finiteOr(overlayHeight, 0),
  );
  const safeActivity = Math.max(
    0,
    Math.min(1, finiteOr(activityOpacity, 0)),
  );
  const safeMaxHeight = Math.max(
    0,
    finiteOr(maxHeight, Number.MAX_VALUE),
  );
  const desiredHeight =
    safeBarHeight * 1.18 +
    safeOverlayHeight * 0.07 * Math.sqrt(safeActivity);

  return Math.min(safeMaxHeight, desiredHeight);
}

export function getWaveformMaxPeakHeight(
  width: number,
  height: number,
  edgeBlurRadius = 0,
) {
  const safeWidth = Math.max(1, finiteOr(width, 1));
  const safeHeight = Math.max(1, finiteOr(height, 1));
  const safeEdgeBlurRadius = Math.max(0, finiteOr(edgeBlurRadius, 0));
  const logoTopRatio = getWaveformLogoTopRatio(safeWidth / safeHeight);

  return Math.max(
    safeHeight * 0.1,
    safeHeight * (1 - logoTopRatio * 2) - safeEdgeBlurRadius * 6,
  );
}

export function isWaveformEdgeToEdgeRatio(ratio: number) {
  return (
    isRatio(ratio, 1) ||
    isRatio(ratio, 3 / 4) ||
    isRatio(ratio, 4 / 3) ||
    isRatio(ratio, 9 / 16)
  );
}

function roundToMatchingParity(
  value: number,
  paritySource: number,
  minimum: number,
) {
  const rounded = Math.max(minimum, Math.round(value));

  if (Math.abs(rounded - paritySource) % 2 === 0) {
    return rounded;
  }

  const candidates = [rounded - 1, rounded + 1].filter(
    (candidate) =>
      candidate >= minimum &&
      Math.abs(candidate - paritySource) % 2 === 0,
  );

  return candidates.reduce((closest, candidate) =>
    Math.abs(candidate - value) < Math.abs(closest - value)
      ? candidate
      : closest,
  );
}

function getWaveformHeightScale(ratio: number) {
  if (isRatio(ratio, 1)) {
    return 0.757576;
  }

  if (isRatio(ratio, 3 / 4)) {
    return 0.984848;
  }

  if (isRatio(ratio, 9 / 16)) {
    return 0.738636;
  }

  return 1;
}

function getWaveformBarWidthScale(ratio: number) {
  // Portrait previews are displayed narrower than square/landscape frames.
  // These scales resolve to a crisp 6 px export bar (versus 4 px at 1:1),
  // which is only subtly wider on screen while the reduced odd counts create
  // the requested larger, evenly distributed gaps.
  if (isRatio(ratio, 9 / 16)) {
    return WAVEFORM_NINE_BY_SIXTEEN_WIDTH_SCALE;
  }

  if (isRatio(ratio, 3 / 4)) {
    return WAVEFORM_THREE_BY_FOUR_WIDTH_SCALE;
  }

  return 1;
}

function getWaveformLogoTopRatio(ratio: number) {
  return isRatio(ratio, 9 / 16) ? 0.13125 : 0.075;
}

function isRatio(actual: number, expected: number) {
  return Math.abs(actual - expected) < 0.01;
}

function finiteOr(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}
