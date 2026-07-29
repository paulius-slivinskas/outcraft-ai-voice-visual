import { sampleWaveformSpectrum } from "./audioSpectrum";
import { WAVEFORM_DEFAULT_BAR_COUNT } from "./waveformGeometry";

export type WaveformStyle = {
  bellBoost: number;
  boxScale: number;
  centerEnvelopePower: number;
  centerGain: number;
  edgeGain: number;
  noiseFloor: number;
  sideFloor: number;
  sideMotionMix: number;
  useStarProfile: boolean;
  verticalGain: number;
  widthFactor: number;
};

export type WaveformBar = {
  blurProgress: number;
  centerOffsetRatio: number;
  heightRatio: number;
  opacity: number;
};

export type WaveformBarsOptions = {
  barCount?: number;
  timestampSeconds?: number;
};

export const WAVEFORM_AMPLITUDE_SCALE = 4;
export const WAVEFORM_EDGE_BLUR_MAX_RATIO = 0.008;
export const WAVEFORM_EDGE_BLUR_START_RATIO = 0.16;
export const WAVEFORM_GLOW_BLUR_MAX_RATIO = 0.004;

const WAVEFORM_HEIGHT_SOFT_CEILING = 1.65;
const WAVEFORM_MAX_BLUR_MIX = 0.72;

export function getWaveformStyle(
  overrides: Partial<WaveformStyle> = {},
): WaveformStyle {
  return {
    bellBoost: 1,
    boxScale: 1,
    centerEnvelopePower: 3,
    centerGain: 1.5,
    edgeGain: 1,
    noiseFloor: 0.02,
    sideFloor: 0.06,
    sideMotionMix: 0.05,
    useStarProfile: false,
    verticalGain: 1,
    widthFactor: 1,
    ...overrides,
  };
}

export function createWaveformBars(
  audioSpectrum: ArrayLike<number>,
  styleOverrides: Partial<WaveformStyle>,
  options: WaveformBarsOptions = {},
): WaveformBar[] {
  const style = getWaveformStyle(styleOverrides);
  const requestedBarCount = Math.max(
    3,
    Math.round(
      Number.isFinite(options.barCount)
        ? options.barCount!
        : WAVEFORM_DEFAULT_BAR_COUNT,
    ),
  );
  const barCount =
    requestedBarCount % 2 === 0
      ? requestedBarCount + 1
      : requestedBarCount;
  const halfSpan = (barCount - 1) / 2;
  void options.timestampSeconds;
  const voiceScan = Array.from({ length: 64 }, (_, sampleIndex) => {
    const progress = sampleIndex / 63;

    return {
      level: sampleWaveformSpectrum(audioSpectrum, progress),
      progress,
    };
  });
  const voicePeakLevel = voiceScan.reduce(
    (peak, sample) => Math.max(peak, sample.level),
    0,
  );
  let voiceWeightTotal = 0;
  let voiceProgressTotal = 0;

  voiceScan.forEach((sample) => {
    const relativeLevel =
      voicePeakLevel <= Number.EPSILON
        ? 0
        : sample.level / voicePeakLevel;
    const weight = relativeLevel ** 6;
    voiceWeightTotal += weight;
    voiceProgressTotal += sample.progress * weight;
  });

  const voicePeakProgress =
    voiceWeightTotal <= Number.EPSILON
      ? 0
      : voiceProgressTotal / voiceWeightTotal;

  const spectrumSamples = Array.from({ length: barCount }, (_, index) => {
    const centerDistance =
      Math.abs(index - halfSpan) / Math.max(halfSpan, 1);
    // Anchor the strongest voice band to the true centre, then walk toward
    // higher frequencies symmetrically. This keeps a single raised central
    // point even when the spectrum begins with sub-bass silence.
    const sourceProgress = clamp01(
      voicePeakProgress +
        centerDistance *
          style.widthFactor *
          (1 - voicePeakProgress),
    );
    // A small spectral blur prevents adjacent FFT bins from producing
    // needle-like frame-to-frame hits while retaining the voice contour.
    const band =
      sampleWaveformSpectrum(audioSpectrum, sourceProgress) * 0.5 +
      sampleWaveformSpectrum(audioSpectrum, sourceProgress - 0.018) *
        0.25 +
      sampleWaveformSpectrum(audioSpectrum, sourceProgress + 0.018) *
        0.25;
    const normalizedBand = clamp01(
      (band - style.noiseFloor) /
        Math.max(1e-6, 1 - style.noiseFloor),
    );

    return {
      centerDistance,
      normalizedBand,
    };
  });
  const framePeak = spectrumSamples.reduce(
    (peak, sample) => Math.max(peak, sample.normalizedBand),
    0,
  );

  return spectrumSamples.map(({ centerDistance, normalizedBand }) => {
    const centerEnvelope =
      style.sideFloor +
      (1 - centerDistance) ** style.centerEnvelopePower *
        (1 - style.sideFloor);
    const gainWeight =
      (1 - centerDistance) ** style.centerEnvelopePower;
    const gain =
      style.edgeGain +
      (style.centerGain - style.edgeGain) * gainWeight;
    const shapedBand =
      normalizedBand * style.sideMotionMix +
      normalizedBand *
        centerEnvelope *
        (1 - style.sideMotionMix);
    const effectiveBand = clamp01(shapedBand * gain);
    const bell =
      1 + style.bellBoost * (1 - centerDistance) ** 6;
    const rawHeight =
      (effectiveBand * bell + framePeak * 0.018) *
      style.verticalGain;

    return {
      blurProgress: getWaveformEdgeBlurProgress(centerDistance),
      centerOffsetRatio: 0,
      heightRatio: softLimitWaveformHeight(rawHeight),
      opacity: getWaveformBarOpacity(centerDistance),
    };
  });
}

export function getWaveformBarLayerOpacities(
  bar: Pick<WaveformBar, "blurProgress" | "opacity">,
) {
  const opacity = clamp01(bar.opacity);
  const blurMix =
    clamp01(bar.blurProgress) * WAVEFORM_MAX_BLUR_MIX;

  return {
    blurOpacity: opacity * blurMix,
    sharpOpacity: opacity * (1 - blurMix),
  };
}

export function getWaveformBarGlowOpacity(
  bar: Pick<WaveformBar, "blurProgress" | "opacity">,
  activityOpacity: number,
) {
  const safeActivity = clamp01(activityOpacity);

  return (
    clamp01(bar.opacity) *
    safeActivity *
    0.2 *
    (1 - clamp01(bar.blurProgress) * 0.25)
  );
}

function softLimitWaveformHeight(height: number) {
  return (
    WAVEFORM_HEIGHT_SOFT_CEILING *
    Math.tanh(
      Math.max(0, height) / WAVEFORM_HEIGHT_SOFT_CEILING,
    )
  );
}

function getWaveformBarOpacity(centerDistance: number) {
  return 1 - 0.84 * smoothstep(0.34, 1, centerDistance);
}

function getWaveformEdgeBlurProgress(centerDistance: number) {
  return smoothstep(
    WAVEFORM_EDGE_BLUR_START_RATIO,
    1,
    centerDistance,
  );
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const progress = clamp01(
    (value - edge0) / Math.max(edge1 - edge0, Number.EPSILON),
  );

  return progress * progress * (3 - 2 * progress);
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}
