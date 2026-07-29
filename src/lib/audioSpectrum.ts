import {
  getAudioEnvelope,
  getAudioEnvelopeAmount,
} from "./audioEnvelope";

export const AUDIO_SPECTRUM_BAND_COUNT = 64;
export const AUDIO_SPECTRUM_FFT_SIZE = 2048;
export const AUDIO_SPECTRUM_MIN_FREQUENCY_HZ = 40;
export const AUDIO_SPECTRUM_MAX_FREQUENCY_HZ = 16_000;
export const AUDIO_SPECTRUM_MIN_DECIBELS = -72;
export const AUDIO_SPECTRUM_MAX_DECIBELS = -6;
// Keep the waveform sidechain separate from the shader's full 40 Hz–16 kHz
// spectrum. Waveform bars map 80 Hz–8 kHz logarithmically, remain fully
// responsive through 7 kHz, then roll off smoothly to silence at 8 kHz.
export const AUDIO_WAVEFORM_MIN_FREQUENCY_HZ = 80;
export const AUDIO_WAVEFORM_FULL_RESPONSE_MAX_FREQUENCY_HZ = 7_000;
export const AUDIO_WAVEFORM_MAX_FREQUENCY_HZ = 8_000;
// AnalyserNode reports the raw Blackman-window FFT magnitude (roughly A/2
// times the 0.42 coherent gain for a bin-centred sine), while the offline FFT
// compensates that gain to report signal amplitude. Undo the analyser loss so
// preview and export share the same dBFS scale.
export const AUDIO_SPECTRUM_ANALYSER_GAIN_DECIBELS =
  20 * Math.log10(2 / 0.42);

export type LiveAudioSpectrumState = {
  // Web Audio writes into an ArrayBuffer-backed view; SharedArrayBuffer views
  // are intentionally excluded by AnalyserNode's DOM type.
  readonly decibels: Float32Array<ArrayBuffer>;
  lastTimestampMs: number | null;
  readonly rawSpectrum: Float32Array;
  readonly smoothedSpectrum: Float32Array;
};

export function configureLiveAudioAnalyser(analyser: AnalyserNode) {
  analyser.fftSize = AUDIO_SPECTRUM_FFT_SIZE;
  analyser.minDecibels = AUDIO_SPECTRUM_MIN_DECIBELS;
  analyser.maxDecibels = AUDIO_SPECTRUM_MAX_DECIBELS;
  analyser.smoothingTimeConstant = 0;
}

export function createLiveAudioSpectrumState(
  analyser: AnalyserNode,
): LiveAudioSpectrumState {
  return {
    decibels: new Float32Array(analyser.frequencyBinCount),
    lastTimestampMs: null,
    rawSpectrum: new Float32Array(AUDIO_SPECTRUM_BAND_COUNT),
    smoothedSpectrum: new Float32Array(AUDIO_SPECTRUM_BAND_COUNT),
  };
}

export function updateLiveAudioSpectrum(
  analyser: AnalyserNode,
  state: LiveAudioSpectrumState,
  audioSmoothness: number,
  timestampMs: number,
) {
  if (state.decibels.length !== analyser.frequencyBinCount) {
    throw new Error("Live audio analyser size changed unexpectedly.");
  }

  analyser.getFloatFrequencyData(state.decibels);
  writeLogSpectrumFromDecibels(
    state.decibels,
    analyser.context.sampleRate,
    analyser.fftSize,
    state.rawSpectrum,
  );

  const deltaSeconds =
    state.lastTimestampMs === null
      ? 1 / 60
      : Math.max(0, timestampMs - state.lastTimestampMs) / 1000;
  const envelope = getAudioEnvelope(audioSmoothness);
  const attackAmount = getAudioEnvelopeAmount(
    deltaSeconds,
    envelope.attackTimeSeconds,
  );
  const releaseAmount = getAudioEnvelopeAmount(
    deltaSeconds,
    envelope.releaseTimeSeconds,
  );

  for (let index = 0; index < state.smoothedSpectrum.length; index += 1) {
    const current = state.smoothedSpectrum[index] ?? 0;
    const target = state.rawSpectrum[index] ?? 0;
    const amount = target > current ? attackAmount : releaseAmount;
    state.smoothedSpectrum[index] = current + (target - current) * amount;
  }

  state.lastTimestampMs = timestampMs;
  return state.smoothedSpectrum;
}

export function writeLogSpectrumFromDecibels(
  decibels: Float32Array,
  sampleRate: number,
  fftSize: number,
  output: Float32Array,
) {
  if (output.length < AUDIO_SPECTRUM_BAND_COUNT) {
    throw new RangeError(
      `output must contain at least ${AUDIO_SPECTRUM_BAND_COUNT} values.`,
    );
  }

  const nyquist = sampleRate / 2;
  const maxFrequency = Math.min(AUDIO_SPECTRUM_MAX_FREQUENCY_HZ, nyquist);
  const minLog = Math.log(AUDIO_SPECTRUM_MIN_FREQUENCY_HZ);
  const maxLog = Math.log(maxFrequency);
  const decibelRange =
    AUDIO_SPECTRUM_MAX_DECIBELS - AUDIO_SPECTRUM_MIN_DECIBELS;

  for (let bandIndex = 0; bandIndex < AUDIO_SPECTRUM_BAND_COUNT; bandIndex += 1) {
    const startFrequency = Math.exp(
      minLog +
        (maxLog - minLog) * (bandIndex / AUDIO_SPECTRUM_BAND_COUNT),
    );
    const endFrequency = Math.exp(
      minLog +
        (maxLog - minLog) *
          ((bandIndex + 1) / AUDIO_SPECTRUM_BAND_COUNT),
    );
    const startBin = clampInteger(
      Math.floor((startFrequency * fftSize) / sampleRate),
      1,
      decibels.length - 1,
    );
    const endBin = clampInteger(
      Math.ceil((endFrequency * fftSize) / sampleRate),
      startBin + 1,
      decibels.length,
    );
    let powerSum = 0;

    for (let binIndex = startBin; binIndex < endBin; binIndex += 1) {
      const binDecibels = decibels[binIndex] ?? -Infinity;
      powerSum += Number.isFinite(binDecibels)
        ? 10 **
          ((binDecibels + AUDIO_SPECTRUM_ANALYSER_GAIN_DECIBELS) / 10)
        : 0;
    }

    const averagePower = powerSum / Math.max(1, endBin - startBin);
    const bandDecibels = 10 * Math.log10(Math.max(averagePower, 1e-24));
    output[bandIndex] = clamp01(
      (bandDecibels - AUDIO_SPECTRUM_MIN_DECIBELS) / decibelRange,
    );
  }

  return output;
}

export function sampleWaveformSpectrum(
  spectrum: ArrayLike<number>,
  progress: number,
) {
  if (spectrum.length === 0) {
    return 0;
  }

  const frequency = getWaveformFrequencyAtProgress(progress);
  const fractionalIndex = getSpectrumFractionalIndex(
    frequency,
    spectrum.length,
  );
  // The shared shader spectrum continues through 16 kHz. Restrict waveform
  // interpolation to source band centres inside its own 80 Hz–8 kHz range so
  // energy above the sidechain cutoff cannot leak in through the upper sample.
  const minimumIndex = clampInteger(
    Math.ceil(
      getSpectrumFractionalIndex(
        AUDIO_WAVEFORM_MIN_FREQUENCY_HZ,
        spectrum.length,
      ),
    ),
    0,
    spectrum.length - 1,
  );
  const maximumIndex = clampInteger(
    Math.floor(
      getSpectrumFractionalIndex(
        AUDIO_WAVEFORM_MAX_FREQUENCY_HZ,
        spectrum.length,
      ),
    ),
    minimumIndex,
    spectrum.length - 1,
  );
  // Spectrum values represent logarithmic band centres rather than edges.
  const lowerIndex = clampInteger(
    Math.floor(fractionalIndex),
    minimumIndex,
    maximumIndex,
  );
  const upperIndex = clampInteger(
    Math.ceil(fractionalIndex),
    minimumIndex,
    maximumIndex,
  );
  const mix = clamp01(fractionalIndex - Math.floor(fractionalIndex));
  const lowerValue = finiteSpectrumValue(spectrum[lowerIndex]);
  const upperValue = finiteSpectrumValue(spectrum[upperIndex]);
  const interpolated = lowerValue + (upperValue - lowerValue) * mix;

  return clamp01(
    interpolated * getWaveformFrequencyWeight(frequency),
  );
}

export function getWaveformFrequencyAtProgress(progress: number) {
  const safeProgress = clamp01(progress);

  return (
    AUDIO_WAVEFORM_MIN_FREQUENCY_HZ *
    (AUDIO_WAVEFORM_MAX_FREQUENCY_HZ /
      AUDIO_WAVEFORM_MIN_FREQUENCY_HZ) **
      safeProgress
  );
}

export function getWaveformFrequencyWeight(frequencyHz: number) {
  if (
    !Number.isFinite(frequencyHz) ||
    frequencyHz < AUDIO_WAVEFORM_MIN_FREQUENCY_HZ ||
    frequencyHz >= AUDIO_WAVEFORM_MAX_FREQUENCY_HZ
  ) {
    return 0;
  }

  if (frequencyHz <= AUDIO_WAVEFORM_FULL_RESPONSE_MAX_FREQUENCY_HZ) {
    return 1;
  }

  const progress =
    (frequencyHz - AUDIO_WAVEFORM_FULL_RESPONSE_MAX_FREQUENCY_HZ) /
    (AUDIO_WAVEFORM_MAX_FREQUENCY_HZ -
      AUDIO_WAVEFORM_FULL_RESPONSE_MAX_FREQUENCY_HZ);

  return 1 - smoothstep01(progress);
}

function getSpectrumFractionalIndex(
  frequencyHz: number,
  spectrumLength: number,
) {
  const spectrumProgress = clamp01(
    Math.log(frequencyHz / AUDIO_SPECTRUM_MIN_FREQUENCY_HZ) /
      Math.log(
        AUDIO_SPECTRUM_MAX_FREQUENCY_HZ /
          AUDIO_SPECTRUM_MIN_FREQUENCY_HZ,
      ),
  );

  return spectrumProgress * spectrumLength - 0.5;
}

function smoothstep01(value: number) {
  const progress = clamp01(value);

  return progress * progress * (3 - 2 * progress);
}

function clamp01(value: number) {
  if (value === Number.POSITIVE_INFINITY) {
    return 1;
  }

  return Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0;
}

function finiteSpectrumValue(value: number | undefined) {
  return Number.isFinite(value) ? value! : 0;
}

function clampInteger(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
