import {
  AUDIO_SPECTRUM_BAND_COUNT,
  AUDIO_SPECTRUM_FFT_SIZE,
  AUDIO_SPECTRUM_MAX_DECIBELS,
  AUDIO_SPECTRUM_MAX_FREQUENCY_HZ,
  AUDIO_SPECTRUM_MIN_DECIBELS,
  AUDIO_SPECTRUM_MIN_FREQUENCY_HZ,
} from "../lib/audioSpectrum";

export { AUDIO_SPECTRUM_BAND_COUNT } from "../lib/audioSpectrum";
const DEFAULT_ATTACK_TIME_SECONDS = 0.035;
const DEFAULT_RELEASE_TIME_SECONDS = 0.16;
const DEFAULT_YIELD_EVERY_FRAMES = 96;

export type AudioBufferLike = Pick<
  AudioBuffer,
  "getChannelData" | "length" | "numberOfChannels" | "sampleRate"
>;

export type AudioAnalysisTimeline = {
  readonly bandCount: number;
  readonly data: Float32Array;
  readonly durationSeconds: number;
  readonly frameCount: number;
  readonly frameRate: number;
};

export type AudioAnalysisOptions = {
  attackTimeSeconds?: number;
  durationSeconds?: number;
  fftSize?: number;
  maxDecibels?: number;
  maxFrequencyHz?: number;
  minDecibels?: number;
  minFrequencyHz?: number;
  releaseTimeSeconds?: number;
};

export type AsyncAudioAnalysisOptions = AudioAnalysisOptions & {
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
  yieldEveryFrames?: number;
};

export type FrequencyBandMap = {
  readonly bandCount: number;
  readonly endBins: Int32Array;
  readonly startBins: Int32Array;
};

export type FftPlan = {
  readonly bitReversal: Uint32Array;
  readonly cosine: Float32Array;
  readonly sine: Float32Array;
  readonly size: number;
};

export type AudioSpectrumAnalyzer = {
  readonly bandCount: number;
  readonly frameRate: number;
  analyzeFrame: (frameIndex: number, output: Float32Array) => Float32Array;
};

type TimelineBuilder = {
  readonly analyzer: AudioSpectrumAnalyzer;
  readonly attackAmount: number;
  readonly frameCount: number;
  readonly releaseAmount: number;
  readonly smoothed: Float32Array;
  readonly timeline: AudioAnalysisTimeline;
  processFrame: (frameIndex: number) => void;
};

/**
 * Creates a deterministic spectrum timeline for reuse across one or more encoders.
 * The returned data is laid out as `frameCount * 64` contiguous normalized values.
 */
export function createAudioAnalysisTimeline(
  audioBuffer: AudioBufferLike,
  frameRate: number,
  options: AudioAnalysisOptions = {},
): AudioAnalysisTimeline {
  const builder = createTimelineBuilder(audioBuffer, frameRate, options);

  for (let frameIndex = 0; frameIndex < builder.frameCount; frameIndex += 1) {
    builder.processFrame(frameIndex);
  }

  return builder.timeline;
}

/**
 * Async variant of {@link createAudioAnalysisTimeline}. It periodically yields so
 * cancellation and UI work can be observed while analysing long audio files.
 */
export async function createAudioAnalysisTimelineAsync(
  audioBuffer: AudioBufferLike,
  frameRate: number,
  options: AsyncAudioAnalysisOptions = {},
): Promise<AudioAnalysisTimeline> {
  const builder = createTimelineBuilder(audioBuffer, frameRate, options);
  const yieldEveryFrames = validatePositiveInteger(
    options.yieldEveryFrames ?? DEFAULT_YIELD_EVERY_FRAMES,
    "yieldEveryFrames",
  );

  throwIfAborted(options.signal);
  options.onProgress?.(0);

  for (let frameIndex = 0; frameIndex < builder.frameCount; frameIndex += 1) {
    builder.processFrame(frameIndex);

    if (
      (frameIndex + 1) % yieldEveryFrames === 0 &&
      frameIndex + 1 < builder.frameCount
    ) {
      options.onProgress?.((frameIndex + 1) / builder.frameCount);
      await yieldToEventLoop();
      throwIfAborted(options.signal);
    }
  }

  throwIfAborted(options.signal);
  options.onProgress?.(1);
  return builder.timeline;
}

/**
 * Creates an allocation-stable analyser. Calls may be made in any frame order;
 * each result depends only on the source audio and the requested frame index.
 */
export function createAudioSpectrumAnalyzer(
  audioBuffer: AudioBufferLike,
  frameRate: number,
  options: AudioAnalysisOptions = {},
): AudioSpectrumAnalyzer {
  validateAudioBuffer(audioBuffer);
  validatePositiveFinite(frameRate, "frameRate");

  const fftSize = validatePowerOfTwo(
    options.fftSize ?? AUDIO_SPECTRUM_FFT_SIZE,
    "fftSize",
  );
  const minDecibels = finiteOrDefault(
    options.minDecibels,
    AUDIO_SPECTRUM_MIN_DECIBELS,
    "minDecibels",
  );
  const maxDecibels = finiteOrDefault(
    options.maxDecibels,
    AUDIO_SPECTRUM_MAX_DECIBELS,
    "maxDecibels",
  );

  if (maxDecibels <= minDecibels) {
    throw new RangeError("maxDecibels must be greater than minDecibels.");
  }

  const channelData = Array.from(
    { length: audioBuffer.numberOfChannels },
    (_, channelIndex) => audioBuffer.getChannelData(channelIndex),
  );
  const window = createBlackmanWindow(fftSize);
  const windowSum = window.reduce((sum, value) => sum + value, 0);
  const real = new Float32Array(fftSize);
  const imaginary = new Float32Array(fftSize);
  const fftPlan = createFftPlan(fftSize);
  const bandMap = createLogFrequencyBandMap(
    audioBuffer.sampleRate,
    fftSize,
    AUDIO_SPECTRUM_BAND_COUNT,
    options.minFrequencyHz ?? AUDIO_SPECTRUM_MIN_FREQUENCY_HZ,
    options.maxFrequencyHz ?? AUDIO_SPECTRUM_MAX_FREQUENCY_HZ,
  );
  const amplitudeScale = 2 / Math.max(windowSum, Number.EPSILON);

  return {
    bandCount: AUDIO_SPECTRUM_BAND_COUNT,
    frameRate,
    analyzeFrame(frameIndex, output) {
      validateFrameIndex(frameIndex);

      if (output.length < AUDIO_SPECTRUM_BAND_COUNT) {
        throw new RangeError(
          `output must contain at least ${AUDIO_SPECTRUM_BAND_COUNT} values.`,
        );
      }

      const centerSample = Math.round(
        ((frameIndex + 0.5) / frameRate) * audioBuffer.sampleRate,
      );
      const firstSample = centerSample - fftSize / 2;

      for (let fftIndex = 0; fftIndex < fftSize; fftIndex += 1) {
        const sourceIndex = firstSample + fftIndex;
        let monoSample = 0;

        if (sourceIndex >= 0 && sourceIndex < audioBuffer.length) {
          for (
            let channelIndex = 0;
            channelIndex < channelData.length;
            channelIndex += 1
          ) {
            monoSample += channelData[channelIndex][sourceIndex] ?? 0;
          }
          monoSample /= channelData.length;
        }

        real[fftIndex] = monoSample * (window[fftIndex] ?? 0);
        imaginary[fftIndex] = 0;
      }

      fftInPlace(real, imaginary, fftPlan);
      writeLogSpectrum(
        real,
        imaginary,
        bandMap,
        amplitudeScale,
        minDecibels,
        maxDecibels,
        output,
      );
      return output;
    },
  };
}

export function calculateAudioAnalysisFrameCount(
  durationSeconds: number,
  frameRate: number,
) {
  validateNonNegativeFinite(durationSeconds, "durationSeconds");
  validatePositiveFinite(frameRate, "frameRate");

  if (durationSeconds === 0) {
    return 0;
  }

  return Math.ceil(durationSeconds * frameRate - 1e-9);
}

export function copyAudioSpectrumFrame(
  timeline: AudioAnalysisTimeline,
  frameIndex: number,
  output: Float32Array,
) {
  validateFrameIndex(frameIndex);

  if (output.length < timeline.bandCount) {
    throw new RangeError(
      `output must contain at least ${timeline.bandCount} values.`,
    );
  }

  if (frameIndex >= timeline.frameCount) {
    output.fill(0, 0, timeline.bandCount);
    return output;
  }

  const sourceOffset = frameIndex * timeline.bandCount;
  output.set(
    timeline.data.subarray(sourceOffset, sourceOffset + timeline.bandCount),
    0,
  );
  return output;
}

export function createFftPlan(size: number): FftPlan {
  validatePowerOfTwo(size, "size");

  const bitCount = Math.log2(size);
  const bitReversal = new Uint32Array(size);
  const cosine = new Float32Array(size / 2);
  const sine = new Float32Array(size / 2);

  for (let index = 0; index < size; index += 1) {
    let source = index;
    let reversed = 0;

    for (let bit = 0; bit < bitCount; bit += 1) {
      reversed = (reversed << 1) | (source & 1);
      source >>>= 1;
    }
    bitReversal[index] = reversed;
  }

  for (let index = 0; index < size / 2; index += 1) {
    const angle = (-2 * Math.PI * index) / size;
    cosine[index] = Math.cos(angle);
    sine[index] = Math.sin(angle);
  }

  return { bitReversal, cosine, sine, size };
}

/**
 * Radix-2 Cooley-Tukey FFT. Both arrays are mutated in place and no memory is
 * allocated while transforming.
 */
export function fftInPlace(
  real: Float32Array,
  imaginary: Float32Array,
  plan: FftPlan = createFftPlan(real.length),
) {
  const { size } = plan;

  if (real.length !== size || imaginary.length !== size) {
    throw new RangeError("FFT inputs must match the plan size.");
  }

  for (let index = 0; index < size; index += 1) {
    const reversedIndex = plan.bitReversal[index] ?? 0;

    if (reversedIndex <= index) {
      continue;
    }

    const realValue = real[index] ?? 0;
    real[index] = real[reversedIndex] ?? 0;
    real[reversedIndex] = realValue;

    const imaginaryValue = imaginary[index] ?? 0;
    imaginary[index] = imaginary[reversedIndex] ?? 0;
    imaginary[reversedIndex] = imaginaryValue;
  }

  for (let blockSize = 2; blockSize <= size; blockSize *= 2) {
    const halfBlockSize = blockSize / 2;
    const tableStep = size / blockSize;

    for (let blockStart = 0; blockStart < size; blockStart += blockSize) {
      for (let offset = 0; offset < halfBlockSize; offset += 1) {
        const twiddleIndex = offset * tableStep;
        const cosine = plan.cosine[twiddleIndex] ?? 1;
        const sine = plan.sine[twiddleIndex] ?? 0;
        const evenIndex = blockStart + offset;
        const oddIndex = evenIndex + halfBlockSize;
        const oddReal = real[oddIndex] ?? 0;
        const oddImaginary = imaginary[oddIndex] ?? 0;
        const rotatedReal = oddReal * cosine - oddImaginary * sine;
        const rotatedImaginary = oddReal * sine + oddImaginary * cosine;
        const evenReal = real[evenIndex] ?? 0;
        const evenImaginary = imaginary[evenIndex] ?? 0;

        real[evenIndex] = evenReal + rotatedReal;
        imaginary[evenIndex] = evenImaginary + rotatedImaginary;
        real[oddIndex] = evenReal - rotatedReal;
        imaginary[oddIndex] = evenImaginary - rotatedImaginary;
      }
    }
  }
}

export function createLogFrequencyBandMap(
  sampleRate: number,
  fftSize: number,
  bandCount = AUDIO_SPECTRUM_BAND_COUNT,
  minFrequencyHz = AUDIO_SPECTRUM_MIN_FREQUENCY_HZ,
  maxFrequencyHz = AUDIO_SPECTRUM_MAX_FREQUENCY_HZ,
): FrequencyBandMap {
  validatePositiveFinite(sampleRate, "sampleRate");
  validatePowerOfTwo(fftSize, "fftSize");
  validatePositiveInteger(bandCount, "bandCount");
  validatePositiveFinite(minFrequencyHz, "minFrequencyHz");
  validatePositiveFinite(maxFrequencyHz, "maxFrequencyHz");

  const nyquist = sampleRate / 2;
  const upperFrequency = Math.min(maxFrequencyHz, nyquist);

  if (upperFrequency <= minFrequencyHz) {
    throw new RangeError(
      "maxFrequencyHz must be above minFrequencyHz and below Nyquist.",
    );
  }

  const startBins = new Int32Array(bandCount);
  const endBins = new Int32Array(bandCount);
  const maxBinExclusive = fftSize / 2 + 1;
  const minLog = Math.log(minFrequencyHz);
  const maxLog = Math.log(upperFrequency);

  for (let bandIndex = 0; bandIndex < bandCount; bandIndex += 1) {
    const startFrequency = Math.exp(
      minLog + (maxLog - minLog) * (bandIndex / bandCount),
    );
    const endFrequency = Math.exp(
      minLog + (maxLog - minLog) * ((bandIndex + 1) / bandCount),
    );
    const startBin = clampInteger(
      Math.floor((startFrequency * fftSize) / sampleRate),
      1,
      maxBinExclusive - 1,
    );
    const endBin = clampInteger(
      Math.ceil((endFrequency * fftSize) / sampleRate),
      startBin + 1,
      maxBinExclusive,
    );

    startBins[bandIndex] = startBin;
    endBins[bandIndex] = endBin;
  }

  return { bandCount, endBins, startBins };
}

export function createHannWindow(size: number) {
  validatePositiveInteger(size, "size");

  const window = new Float32Array(size);

  if (size === 1) {
    window[0] = 1;
    return window;
  }

  for (let index = 0; index < size; index += 1) {
    window[index] = 0.5 * (1 - Math.cos((2 * Math.PI * index) / (size - 1)));
  }

  return window;
}

export function createBlackmanWindow(size: number) {
  validatePositiveInteger(size, "size");

  const window = new Float32Array(size);

  if (size === 1) {
    window[0] = 1;
    return window;
  }

  const alpha = 0.16;
  const a0 = (1 - alpha) / 2;
  const a1 = 0.5;
  const a2 = alpha / 2;

  for (let index = 0; index < size; index += 1) {
    const phase = (2 * Math.PI * index) / size;
    window[index] =
      a0 - a1 * Math.cos(phase) + a2 * Math.cos(2 * phase);
  }

  return window;
}

function createTimelineBuilder(
  audioBuffer: AudioBufferLike,
  frameRate: number,
  options: AudioAnalysisOptions,
): TimelineBuilder {
  validateAudioBuffer(audioBuffer);
  validatePositiveFinite(frameRate, "frameRate");

  const sourceDurationSeconds = audioBuffer.length / audioBuffer.sampleRate;
  const durationSeconds =
    options.durationSeconds === undefined
      ? sourceDurationSeconds
      : validateNonNegativeFinite(options.durationSeconds, "durationSeconds");
  const frameCount = calculateAudioAnalysisFrameCount(
    durationSeconds,
    frameRate,
  );
  const analyzer = createAudioSpectrumAnalyzer(
    audioBuffer,
    frameRate,
    options,
  );
  const timeline: AudioAnalysisTimeline = {
    bandCount: AUDIO_SPECTRUM_BAND_COUNT,
    data: new Float32Array(frameCount * AUDIO_SPECTRUM_BAND_COUNT),
    durationSeconds,
    frameCount,
    frameRate,
  };
  const rawSpectrum = new Float32Array(AUDIO_SPECTRUM_BAND_COUNT);
  const smoothed = new Float32Array(AUDIO_SPECTRUM_BAND_COUNT);
  const attackTimeSeconds = validateNonNegativeFinite(
    options.attackTimeSeconds ?? DEFAULT_ATTACK_TIME_SECONDS,
    "attackTimeSeconds",
  );
  const releaseTimeSeconds = validateNonNegativeFinite(
    options.releaseTimeSeconds ?? DEFAULT_RELEASE_TIME_SECONDS,
    "releaseTimeSeconds",
  );
  const frameDurationSeconds = 1 / frameRate;
  const attackAmount = smoothingAmount(
    frameDurationSeconds,
    attackTimeSeconds,
  );
  const releaseAmount = smoothingAmount(
    frameDurationSeconds,
    releaseTimeSeconds,
  );

  const builder: TimelineBuilder = {
    analyzer,
    attackAmount,
    frameCount,
    releaseAmount,
    smoothed,
    timeline,
    processFrame(frameIndex) {
      analyzer.analyzeFrame(frameIndex, rawSpectrum);
      const outputOffset = frameIndex * AUDIO_SPECTRUM_BAND_COUNT;

      for (
        let bandIndex = 0;
        bandIndex < AUDIO_SPECTRUM_BAND_COUNT;
        bandIndex += 1
      ) {
        const current = smoothed[bandIndex] ?? 0;
        const target = rawSpectrum[bandIndex] ?? 0;
        const amount = target > current ? attackAmount : releaseAmount;
        const next = current + (target - current) * amount;

        smoothed[bandIndex] = next;
        timeline.data[outputOffset + bandIndex] = next;
      }
    },
  };

  return builder;
}

function writeLogSpectrum(
  real: Float32Array,
  imaginary: Float32Array,
  bandMap: FrequencyBandMap,
  amplitudeScale: number,
  minDecibels: number,
  maxDecibels: number,
  output: Float32Array,
) {
  const decibelRange = maxDecibels - minDecibels;

  for (let bandIndex = 0; bandIndex < bandMap.bandCount; bandIndex += 1) {
    const startBin = bandMap.startBins[bandIndex] ?? 0;
    const endBin = bandMap.endBins[bandIndex] ?? startBin + 1;
    let powerSum = 0;

    for (let binIndex = startBin; binIndex < endBin; binIndex += 1) {
      const realValue = real[binIndex] ?? 0;
      const imaginaryValue = imaginary[binIndex] ?? 0;
      const amplitudeSquared =
        (realValue * realValue + imaginaryValue * imaginaryValue) *
        amplitudeScale *
        amplitudeScale;
      powerSum += amplitudeSquared;
    }

    const rootMeanSquare = Math.sqrt(
      powerSum / Math.max(1, endBin - startBin),
    );
    const decibels = 20 * Math.log10(Math.max(rootMeanSquare, 1e-12));
    output[bandIndex] = clamp01((decibels - minDecibels) / decibelRange);
  }
}

function smoothingAmount(deltaSeconds: number, timeSeconds: number) {
  return timeSeconds === 0 ? 1 : 1 - Math.exp(-deltaSeconds / timeSeconds);
}

function validateAudioBuffer(audioBuffer: AudioBufferLike) {
  if (!audioBuffer || typeof audioBuffer !== "object") {
    throw new TypeError("audioBuffer must be an AudioBuffer-like object.");
  }
  validatePositiveInteger(audioBuffer.sampleRate, "audioBuffer.sampleRate");
  validateNonNegativeInteger(audioBuffer.length, "audioBuffer.length");
  validatePositiveInteger(
    audioBuffer.numberOfChannels,
    "audioBuffer.numberOfChannels",
  );

  for (
    let channelIndex = 0;
    channelIndex < audioBuffer.numberOfChannels;
    channelIndex += 1
  ) {
    const channelData = audioBuffer.getChannelData(channelIndex);

    if (!(channelData instanceof Float32Array)) {
      throw new TypeError("audioBuffer channel data must be Float32Array.");
    }
    if (channelData.length < audioBuffer.length) {
      throw new RangeError("audioBuffer channel data is shorter than length.");
    }
  }
}

function validateFrameIndex(frameIndex: number) {
  validateNonNegativeInteger(frameIndex, "frameIndex");
}

function validatePowerOfTwo(value: number, name: string) {
  validatePositiveInteger(value, name);

  if ((value & (value - 1)) !== 0) {
    throw new RangeError(`${name} must be a power of two.`);
  }

  return value;
}

function validatePositiveInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
  return value;
}

function validateNonNegativeInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer.`);
  }
  return value;
}

function validatePositiveFinite(value: number, name: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number.`);
  }
  return value;
}

function validateNonNegativeFinite(value: number, name: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number.`);
  }
  return value;
}

function finiteOrDefault(
  value: number | undefined,
  fallback: number,
  name: string,
) {
  return value === undefined ? fallback : validateFinite(value, name);
}

function validateFinite(value: number, name: string) {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite.`);
  }
  return value;
}

function clampInteger(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) {
    return;
  }

  throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function yieldToEventLoop() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}
