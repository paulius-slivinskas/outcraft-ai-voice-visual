import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat,
  canEncodeAudio,
  canEncodeVideo,
  type AudioCodec,
  type Target,
  type VideoCodec,
} from "mediabunny";
import {
  AUDIO_SPECTRUM_BAND_COUNT,
  copyAudioSpectrumFrame,
  createAudioAnalysisTimelineAsync,
  type AudioAnalysisTimeline,
} from "./audioAnalysis";

const DEFAULT_AUDIO_BITRATE = 128_000;
const DEFAULT_AUDIO_CHUNK_SECONDS = 1;
const DEFAULT_KEY_FRAME_INTERVAL_SECONDS = 2;
const MONO_AUDIO_OUTPUT_CHANNEL_COUNT = 1;
const ANALYSIS_PROGRESS_WEIGHT = 0.08;
const ENCODE_PROGRESS_WEIGHT = 0.9;

export type OfflineVideoFormat = "mp4" | "webm";
export type OfflineVideoHardwareAcceleration =
  | "no-preference"
  | "prefer-hardware"
  | "prefer-software";
export type OfflineVideoCanvas = HTMLCanvasElement | OffscreenCanvas;

export type OfflineRenderFrameContext = {
  /**
   * Reused scratch storage. Consumers must not retain or mutate this array after
   * the render callback settles.
   */
  readonly audioSpectrum: Float32Array;
  readonly durationSeconds: number;
  readonly frameDurationSeconds: number;
  readonly frameIndex: number;
  readonly timestampSeconds: number;
  readonly totalFrames: number;
};

export type OfflineVideoEncoderOptions<TTarget extends Target = BufferTarget> = {
  audioAnalysisTimeline?: AudioAnalysisTimeline;
  audioBitrate?: number;
  audioBuffer?: AudioBuffer;
  bitrate: number;
  canvas: OfflineVideoCanvas;
  durationSeconds: number;
  format: OfflineVideoFormat;
  fps: number;
  hardwareAcceleration?: OfflineVideoHardwareAcceleration;
  onProgress?: (progress: number) => void;
  renderFrame: (
    context: OfflineRenderFrameContext,
  ) => void | Promise<void>;
  signal?: AbortSignal;
  target?: TTarget;
};

export type OfflineVideoEncoderSupport = {
  readonly audioCodec: AudioCodec | null;
  readonly audioOutputChannelCount: number | null;
  readonly audioOutputSampleRate: number | null;
  readonly supported: boolean;
  readonly unsupportedReason: string | null;
  readonly videoCodec: VideoCodec | null;
};

export type OfflineVideoEncoderResult<TTarget extends Target = BufferTarget> = {
  readonly audioCodec: AudioCodec | null;
  readonly buffer: ArrayBuffer | null;
  readonly durationSeconds: number;
  readonly fileExtension: `.${OfflineVideoFormat}`;
  readonly frameCount: number;
  readonly mimeType: string;
  readonly target: TTarget;
  readonly videoCodec: VideoCodec;
};

type EncoderCapabilityOptions = Pick<
  OfflineVideoEncoderOptions<Target>,
  | "audioBitrate"
  | "audioBuffer"
  | "bitrate"
  | "canvas"
  | "format"
  | "hardwareAcceleration"
  | "signal"
>;

type SelectedCodecs = {
  audioCodec: AudioCodec | null;
  audioOutputChannelCount: number | null;
  audioOutputSampleRate: number | null;
  videoCodec: VideoCodec;
};

/**
 * Encodes a deterministic, fixed-timestep video. `CanvasSource.add` is awaited
 * for every frame, so Mediabunny/WebCodecs backpressure remains bounded.
 *
 * BufferTarget is convenient for short exports. Long exports should provide a
 * streaming Target so the full encoded file does not live in JS memory.
 */
export async function encodeOfflineVideo<
  TTarget extends Target = BufferTarget,
>(
  options: OfflineVideoEncoderOptions<TTarget>,
): Promise<OfflineVideoEncoderResult<TTarget>> {
  const validated = validateEncoderOptions(options);
  const {
    audioBuffer,
    bitrate,
    canvas,
    durationSeconds,
    format,
    fps,
    hardwareAcceleration,
    onProgress,
    renderFrame,
    signal,
  } = validated;
  const frameCount = calculateOfflineVideoFrameCount(durationSeconds, fps);
  const frameStepSeconds = 1 / fps;
  const support = await detectOfflineVideoEncoderSupport({
    audioBitrate: validated.audioBitrate,
    audioBuffer,
    bitrate,
    canvas,
    format,
    hardwareAcceleration,
    signal,
  });

  throwIfAborted(signal);

  if (
    !support.supported ||
    !support.videoCodec
  ) {
    throw new OfflineVideoEncoderUnsupportedError(
      support.unsupportedReason ?? "The requested encoding configuration is unsupported.",
    );
  }

  const selectedCodecs: SelectedCodecs = {
    audioCodec: support.audioCodec,
    audioOutputChannelCount: support.audioOutputChannelCount,
    audioOutputSampleRate: support.audioOutputSampleRate,
    videoCodec: support.videoCodec,
  };
  const analysisProgressWeight =
    audioBuffer && !options.audioAnalysisTimeline
      ? ANALYSIS_PROGRESS_WEIGHT
      : 0;
  const encodeProgressStart = analysisProgressWeight;
  const encodeProgressWeight =
    ENCODE_PROGRESS_WEIGHT + (ANALYSIS_PROGRESS_WEIGHT - analysisProgressWeight);
  let audioAnalysisTimeline = options.audioAnalysisTimeline;

  reportProgress(onProgress, 0);

  if (audioBuffer && !audioAnalysisTimeline) {
    audioAnalysisTimeline = await createAudioAnalysisTimelineAsync(
      audioBuffer,
      fps,
      {
        durationSeconds,
        onProgress: (progress) => {
          reportProgress(onProgress, progress * analysisProgressWeight);
        },
        signal,
      },
    );
  }

  validateTimeline(audioAnalysisTimeline, fps);
  throwIfAborted(signal);

  const target = (options.target ?? new BufferTarget()) as TTarget;
  const outputFormat =
    format === "mp4" ? new Mp4OutputFormat() : new WebMOutputFormat();
  const output = new Output({
    format: outputFormat,
    target,
  });
  const videoSource = new CanvasSource(canvas, {
    bitrate,
    bitrateMode: "variable",
    codec: selectedCodecs.videoCodec,
    hardwareAcceleration,
    keyFrameInterval: DEFAULT_KEY_FRAME_INTERVAL_SECONDS,
    latencyMode: "quality",
    sizeChangeBehavior: "deny",
  });
  output.addVideoTrack(videoSource, { maximumPacketCount: frameCount });

  const audioSource =
    audioBuffer && selectedCodecs.audioCodec
      ? new AudioSampleSource({
          bitrate: validated.audioBitrate,
          bitrateMode: "variable",
          codec: selectedCodecs.audioCodec,
          transform: {
            numberOfChannels:
              selectedCodecs.audioOutputChannelCount ?? undefined,
            sampleRate: selectedCodecs.audioOutputSampleRate ?? undefined,
          },
        })
      : null;

  if (audioSource) {
    output.addAudioTrack(audioSource);
  }

  let cancelPromise: Promise<void> | null = null;
  let didFinalize = false;
  const cancelOutput = () => {
    if (!cancelPromise) {
      cancelPromise =
        output.state === "finalized" || output.state === "finalizing"
          ? Promise.resolve()
          : output.cancel();
    }
    return cancelPromise;
  };
  const onAbort = () => {
    void cancelOutput().catch(() => {
      // The operation path reports the primary error after its current await.
    });
  };

  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await output.start();
    throwIfAborted(signal);

    const audioSpectrum = new Float32Array(AUDIO_SPECTRUM_BAND_COUNT);
    const audioWriter =
      audioBuffer && audioSource
        ? createChunkedAudioWriter(
            audioBuffer,
            audioSource,
            durationSeconds,
          )
        : null;

    if (audioWriter) {
      await audioWriter.writeNextChunk();
      throwIfAborted(signal);
    }

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      throwIfAborted(signal);

      const timestampSeconds = frameIndex / fps;
      const frameDurationSeconds = Math.min(
        frameStepSeconds,
        durationSeconds - timestampSeconds,
      );

      if (audioAnalysisTimeline) {
        copyAudioSpectrumFrame(
          audioAnalysisTimeline,
          frameIndex,
          audioSpectrum,
        );
      } else {
        audioSpectrum.fill(0);
      }

      await renderFrame({
        audioSpectrum,
        durationSeconds,
        frameDurationSeconds,
        frameIndex,
        timestampSeconds,
        totalFrames: frameCount,
      });
      throwIfAborted(signal);

      await videoSource.add(
        timestampSeconds,
        frameDurationSeconds,
      );
      throwIfAborted(signal);

      if (
        audioWriter &&
        audioWriter.hasRemainingAudio() &&
        timestampSeconds + frameDurationSeconds + 1e-9 >=
          audioWriter.writtenUntilSeconds
      ) {
        await audioWriter.writeNextChunk();
        throwIfAborted(signal);
      }

      reportProgress(
        onProgress,
        encodeProgressStart +
          ((frameIndex + 1) / frameCount) * encodeProgressWeight,
      );
    }

    while (audioWriter?.hasRemainingAudio()) {
      await audioWriter.writeNextChunk();
      throwIfAborted(signal);
    }

    videoSource.close();
    audioSource?.close();
    await output.finalize();
    didFinalize = true;
    throwIfAborted(signal);

    const mimeType = await output.getMimeType();
    const buffer = target instanceof BufferTarget ? target.buffer : null;

    if (target instanceof BufferTarget && !buffer) {
      throw new Error("The in-memory output target did not produce a buffer.");
    }

    reportProgress(onProgress, 1);
    return {
      audioCodec: selectedCodecs.audioCodec,
      buffer,
      durationSeconds,
      fileExtension: format === "mp4" ? ".mp4" : ".webm",
      frameCount,
      mimeType,
      target,
      videoCodec: selectedCodecs.videoCodec,
    };
  } catch (error) {
    await cancelOutput().catch(() => {
      // Preserve the original render/encode/cancellation error.
    });

    if (signal?.aborted) {
      throw abortReason(signal);
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);

    if (!didFinalize) {
      await cancelOutput().catch(() => {
        // Cleanup is best-effort after the primary operation has failed.
      });
    }
  }
}

export async function detectOfflineVideoEncoderSupport(
  options: EncoderCapabilityOptions,
): Promise<OfflineVideoEncoderSupport> {
  const bitrate = validatePositiveFinite(options.bitrate, "bitrate");
  const audioBitrate = validatePositiveFinite(
    options.audioBitrate ?? DEFAULT_AUDIO_BITRATE,
    "audioBitrate",
  );
  const { height, width } = validateCanvas(options.canvas);
  validateFormat(options.format);
  throwIfAborted(options.signal);

  const videoCandidates: VideoCodec[] =
    options.format === "mp4" ? ["avc"] : ["vp9", "vp8"];
  let videoCodec: VideoCodec | null = null;

  for (const candidate of videoCandidates) {
    const supported = await safeCanEncodeVideo(candidate, {
      bitrate,
      hardwareAcceleration:
        options.hardwareAcceleration ?? "no-preference",
      height,
      width,
    });
    throwIfAborted(options.signal);

    if (supported) {
      videoCodec = candidate;
      break;
    }
  }

  if (!videoCodec) {
    return {
      audioCodec: null,
      audioOutputChannelCount: null,
      audioOutputSampleRate: null,
      supported: false,
      unsupportedReason:
        options.format === "mp4"
          ? "AVC/H.264 encoding is not supported for this canvas size and bitrate."
          : "Neither VP9 nor VP8 encoding is supported for this canvas size and bitrate.",
      videoCodec: null,
    };
  }

  if (!options.audioBuffer) {
    return {
      audioCodec: null,
      audioOutputChannelCount: null,
      audioOutputSampleRate: null,
      supported: true,
      unsupportedReason: null,
      videoCodec,
    };
  }

  validateAudioBuffer(options.audioBuffer);
  const audioCodec: AudioCodec =
    options.format === "mp4" ? "aac" : "opus";
  // Every exported file uses one encoded channel. AudioSampleSource performs
  // the actual channel remix before AAC/Opus encoding, so stereo input becomes
  // a true mono stream instead of a two-channel dual-mono/stereo track.
  const audioOutputChannelCount = MONO_AUDIO_OUTPUT_CHANNEL_COUNT;
  const audioOutputSampleRate = 48_000;
  const audioSupported = await safeCanEncodeAudio(audioCodec, {
    bitrate: audioBitrate,
    numberOfChannels: audioOutputChannelCount,
    sampleRate: audioOutputSampleRate,
  });
  throwIfAborted(options.signal);

  if (!audioSupported) {
    return {
      audioCodec: null,
      audioOutputChannelCount,
      audioOutputSampleRate,
      supported: false,
      unsupportedReason:
        options.format === "mp4"
          ? "AAC audio encoding is not supported."
          : "Opus audio encoding is not supported.",
      videoCodec,
    };
  }

  return {
    audioCodec,
    audioOutputChannelCount,
    audioOutputSampleRate,
    supported: true,
    unsupportedReason: null,
    videoCodec,
  };
}

export function calculateOfflineVideoFrameCount(
  durationSeconds: number,
  fps: number,
) {
  validatePositiveFinite(durationSeconds, "durationSeconds");
  validatePositiveFinite(fps, "fps");
  const frameCount = Math.ceil(durationSeconds * fps - 1e-9);

  if (!Number.isSafeInteger(frameCount) || frameCount <= 0) {
    throw new RangeError("The requested frame count is outside the safe range.");
  }

  return frameCount;
}

export class OfflineVideoEncoderUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfflineVideoEncoderUnsupportedError";
  }
}

function createChunkedAudioWriter(
  audioBuffer: AudioBuffer,
  source: AudioSampleSource,
  durationSeconds: number,
) {
  const sampleRate = audioBuffer.sampleRate;
  const channelCount = audioBuffer.numberOfChannels;
  const finalSourceFrame = Math.min(
    audioBuffer.length,
    Math.floor(durationSeconds * sampleRate + 1e-9),
  );
  const maxChunkFrames = Math.max(
    1,
    Math.round(sampleRate * DEFAULT_AUDIO_CHUNK_SECONDS),
  );
  const scratch = new Float32Array(maxChunkFrames * channelCount);
  let nextSourceFrame = 0;

  return {
    get writtenUntilSeconds() {
      return nextSourceFrame / sampleRate;
    },
    hasRemainingAudio() {
      return nextSourceFrame < finalSourceFrame;
    },
    async writeNextChunk() {
      if (nextSourceFrame >= finalSourceFrame) {
        return;
      }

      const frameCount = Math.min(
        maxChunkFrames,
        finalSourceFrame - nextSourceFrame,
      );

      for (
        let channelIndex = 0;
        channelIndex < channelCount;
        channelIndex += 1
      ) {
        audioBuffer.copyFromChannel(
          scratch.subarray(
            channelIndex * frameCount,
            (channelIndex + 1) * frameCount,
          ),
          channelIndex,
          nextSourceFrame,
        );
      }

      const sample = new AudioSample({
        data: scratch.subarray(0, frameCount * channelCount),
        format: "f32-planar",
        numberOfChannels: channelCount,
        sampleRate,
        timestamp: nextSourceFrame / sampleRate,
      });

      try {
        await source.add(sample);
      } finally {
        sample.close();
      }

      nextSourceFrame += frameCount;
    },
  };
}

function validateEncoderOptions<TTarget extends Target>(
  options: OfflineVideoEncoderOptions<TTarget>,
) {
  if (!options || typeof options !== "object") {
    throw new TypeError("options must be an object.");
  }
  validateCanvas(options.canvas);
  validateFormat(options.format);
  validatePositiveFinite(options.fps, "fps");
  validatePositiveFinite(options.durationSeconds, "durationSeconds");
  validatePositiveFinite(options.bitrate, "bitrate");
  validatePositiveFinite(
    options.audioBitrate ?? DEFAULT_AUDIO_BITRATE,
    "audioBitrate",
  );

  if (typeof options.renderFrame !== "function") {
    throw new TypeError("renderFrame must be a function.");
  }
  if (
    options.onProgress !== undefined &&
    typeof options.onProgress !== "function"
  ) {
    throw new TypeError("onProgress must be a function.");
  }
  if (
    options.hardwareAcceleration !== undefined &&
    ![
      "no-preference",
      "prefer-hardware",
      "prefer-software",
    ].includes(options.hardwareAcceleration)
  ) {
    throw new TypeError(
      "hardwareAcceleration must be no-preference, prefer-hardware, or prefer-software.",
    );
  }
  if (options.audioBuffer) {
    validateAudioBuffer(options.audioBuffer);
  }

  return {
    ...options,
    audioBitrate: options.audioBitrate ?? DEFAULT_AUDIO_BITRATE,
    hardwareAcceleration:
      options.hardwareAcceleration ?? "no-preference",
  };
}

function validateTimeline(
  timeline: AudioAnalysisTimeline | undefined,
  fps: number,
) {
  if (!timeline) {
    return;
  }
  if (timeline.bandCount !== AUDIO_SPECTRUM_BAND_COUNT) {
    throw new RangeError(
      `audioAnalysisTimeline must contain ${AUDIO_SPECTRUM_BAND_COUNT} bands.`,
    );
  }
  if (Math.abs(timeline.frameRate - fps) > 1e-9) {
    throw new RangeError(
      "audioAnalysisTimeline frameRate must match the encoder fps.",
    );
  }
  if (
    timeline.data.length !==
    timeline.frameCount * timeline.bandCount
  ) {
    throw new RangeError("audioAnalysisTimeline data length is invalid.");
  }
}

function validateCanvas(canvas: OfflineVideoCanvas) {
  if (!canvas || typeof canvas !== "object") {
    throw new TypeError("canvas must be an HTMLCanvasElement or OffscreenCanvas.");
  }

  const width = canvas.width;
  const height = canvas.height;

  if (
    !Number.isInteger(width) ||
    width <= 0 ||
    !Number.isInteger(height) ||
    height <= 0
  ) {
    throw new RangeError("canvas width and height must be positive integers.");
  }

  return { height, width };
}

function validateAudioBuffer(audioBuffer: AudioBuffer) {
  if (
    !Number.isInteger(audioBuffer.sampleRate) ||
    audioBuffer.sampleRate <= 0 ||
    !Number.isInteger(audioBuffer.numberOfChannels) ||
    audioBuffer.numberOfChannels <= 0 ||
    !Number.isInteger(audioBuffer.length) ||
    audioBuffer.length <= 0
  ) {
    throw new RangeError("audioBuffer has invalid channel, rate, or length data.");
  }
}

function validateFormat(format: OfflineVideoFormat) {
  if (format !== "mp4" && format !== "webm") {
    throw new TypeError("format must be either 'mp4' or 'webm'.");
  }
}

function validatePositiveFinite(value: number, name: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number.`);
  }
  return value;
}

async function safeCanEncodeVideo(
  codec: VideoCodec,
  options: {
    bitrate: number;
    hardwareAcceleration: OfflineVideoHardwareAcceleration;
    height: number;
    width: number;
  },
) {
  try {
    return await canEncodeVideo(codec, {
      bitrate: options.bitrate,
      hardwareAcceleration: options.hardwareAcceleration,
      height: options.height,
      latencyMode: "quality",
      width: options.width,
    });
  } catch {
    return false;
  }
}

async function safeCanEncodeAudio(
  codec: AudioCodec,
  options: {
    bitrate: number;
    numberOfChannels: number;
    sampleRate: number;
  },
) {
  try {
    return await canEncodeAudio(codec, {
      bitrate: options.bitrate,
      numberOfChannels: options.numberOfChannels,
      sampleRate: options.sampleRate,
    });
  } catch {
    return false;
  }
}

function reportProgress(
  onProgress: ((progress: number) => void) | undefined,
  progress: number,
) {
  onProgress?.(Math.max(0, Math.min(1, progress)));
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
}

function abortReason(signal: AbortSignal) {
  return (
    signal.reason ??
    new DOMException("The encoding operation was aborted.", "AbortError")
  );
}
