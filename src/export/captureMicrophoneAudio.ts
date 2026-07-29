const recorderTimesliceMs = 1_000;
const progressIntervalMs = 250;
const maximumTimerDurationMs = 2_147_000_000;

const preferredAudioMimeTypes = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
] as const;

type RecorderErrorEvent = Event & {
  error?: DOMException;
};

/**
 * Records a finite microphone sample, then decodes it once for deterministic
 * offline analysis and encoding. Only a clone of the source track is stopped.
 */
export async function captureMicrophoneAudioBuffer(
  stream: MediaStream,
  durationSeconds: number,
  signal: AbortSignal,
  onProgress?: (progress: number) => void,
): Promise<AudioBuffer> {
  validateDuration(durationSeconds);
  throwIfAborted(signal);

  if (typeof MediaRecorder === "undefined") {
    throw new Error("Microphone recording is not supported in this browser.");
  }

  const sourceTrack = stream
    .getAudioTracks()
    .find((track) => track.readyState === "live");

  if (!sourceTrack) {
    throw new Error("No live microphone audio track is available.");
  }

  let clonedTrack: MediaStreamTrack;

  try {
    clonedTrack = sourceTrack.clone();
  } catch (error) {
    throw new Error("The microphone audio track could not be cloned.", {
      cause: error,
    });
  }

  const recordingStream = new MediaStream([clonedTrack]);
  let clonedTrackStopped = false;
  let recorder: MediaRecorder | null = null;
  const stopClonedTrack = () => {
    if (!clonedTrackStopped) {
      clonedTrackStopped = true;
      clonedTrack.stop();
    }
  };

  try {
    recorder = createAudioRecorder(recordingStream);
    const recordedAudio = await recordAudioBlob(
      recorder,
      clonedTrack,
      durationSeconds,
      signal,
      onProgress,
    );
    stopClonedTrack();
    throwIfAborted(signal);

    if (recordedAudio.size <= 0) {
      throw new Error("The microphone recording did not contain any audio data.");
    }

    const encodedAudio = await raceWithAbort(
      recordedAudio.arrayBuffer(),
      signal,
    );
    throwIfAborted(signal);

    if (encodedAudio.byteLength <= 0) {
      throw new Error("The microphone recording was empty.");
    }

    return await decodeRecordedAudio(encodedAudio, signal);
  } finally {
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // The recorder may already be transitioning to its inactive state.
      }
    }

    stopClonedTrack();
  }
}

function createAudioRecorder(stream: MediaStream) {
  let lastError: unknown;

  for (const mimeType of preferredAudioMimeTypes) {
    let isSupported = false;

    try {
      isSupported =
        typeof MediaRecorder.isTypeSupported === "function" &&
        MediaRecorder.isTypeSupported(mimeType);
    } catch {
      isSupported = false;
    }

    if (!isSupported) {
      continue;
    }

    try {
      return new MediaRecorder(stream, { mimeType });
    } catch (error) {
      lastError = error;
    }
  }

  try {
    return new MediaRecorder(stream);
  } catch (error) {
    throw new Error(
      "This browser could not create an audio-only microphone recorder.",
      { cause: lastError ?? error },
    );
  }
}

function recordAudioBlob(
  recorder: MediaRecorder,
  track: MediaStreamTrack,
  durationSeconds: number,
  signal: AbortSignal,
  onProgress?: (progress: number) => void,
) {
  const durationMs = Math.max(1, Math.round(durationSeconds * 1_000));

  return new Promise<Blob>((resolve, reject) => {
    const chunks: BlobPart[] = [];
    let progressTimerId = 0;
    let stopTimerId = 0;
    let startedAt = 0;
    let settled = false;
    let stopRequested = false;

    const cleanup = () => {
      window.clearInterval(progressTimerId);
      window.clearTimeout(stopTimerId);
      signal.removeEventListener("abort", handleAbort);
      track.removeEventListener("ended", handleTrackEnded);
      recorder.removeEventListener("dataavailable", handleDataAvailable);
      recorder.removeEventListener("error", handleRecorderError);
      recorder.removeEventListener("stop", handleRecorderStop);
    };

    const settleWithError = (error: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();

      if (recorder.state !== "inactive") {
        stopRequested = true;

        try {
          recorder.stop();
        } catch {
          // Reject with the primary failure.
        }
      }

      reject(error);
    };

    const requestStop = () => {
      if (stopRequested || settled) {
        return;
      }

      stopRequested = true;

      try {
        if (recorder.state === "inactive") {
          settleWithError(
            new Error("The microphone recorder stopped before the requested duration."),
          );
        } else {
          recorder.stop();
        }
      } catch (error) {
        settleWithError(
          new Error("The microphone recorder could not be stopped cleanly.", {
            cause: error,
          }),
        );
      }
    };

    const handleAbort = () => {
      settleWithError(abortReason(signal));
    };

    const handleTrackEnded = () => {
      settleWithError(
        new Error("The microphone audio track ended before capture completed."),
      );
    };

    const handleDataAvailable = (event: BlobEvent) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    const handleRecorderError = (event: Event) => {
      const recorderError = (event as RecorderErrorEvent).error;

      settleWithError(
        new Error("The microphone recorder reported an error.", {
          cause: recorderError,
        }),
      );
    };

    const handleRecorderStop = () => {
      if (settled) {
        return;
      }

      if (signal.aborted) {
        settleWithError(abortReason(signal));
        return;
      }

      if (!stopRequested) {
        settleWithError(
          new Error("The microphone recorder stopped unexpectedly."),
        );
        return;
      }

      const mimeType =
        recorder.mimeType ||
        chunks.find((chunk): chunk is Blob => chunk instanceof Blob)?.type ||
        "application/octet-stream";

      try {
        const blob = new Blob(chunks, { type: mimeType });

        reportProgress(onProgress, 1);
        settled = true;
        cleanup();
        resolve(blob);
      } catch (error) {
        settleWithError(error);
      }
    };

    signal.addEventListener("abort", handleAbort, { once: true });
    track.addEventListener("ended", handleTrackEnded, { once: true });
    recorder.addEventListener("dataavailable", handleDataAvailable);
    recorder.addEventListener("error", handleRecorderError);
    recorder.addEventListener("stop", handleRecorderStop);

    if (signal.aborted) {
      handleAbort();
      return;
    }

    try {
      reportProgress(onProgress, 0);
      recorder.start(recorderTimesliceMs);
      startedAt = performance.now();
      stopTimerId = window.setTimeout(requestStop, durationMs);
      progressTimerId = window.setInterval(() => {
        try {
          const elapsedMs = performance.now() - startedAt;
          reportProgress(
            onProgress,
            Math.min(0.999, elapsedMs / durationMs),
          );
        } catch (error) {
          settleWithError(error);
        }
      }, progressIntervalMs);
    } catch (error) {
      settleWithError(
        new Error("The microphone recorder could not be started.", {
          cause: error,
        }),
      );
    }
  });
}

async function decodeRecordedAudio(
  encodedAudio: ArrayBuffer,
  signal: AbortSignal,
) {
  throwIfAborted(signal);

  let audioContext: AudioContext;

  try {
    audioContext = new AudioContext();
  } catch (error) {
    throw new Error("The browser could not initialize an audio decoder.", {
      cause: error,
    });
  }

  let audioBuffer: AudioBuffer;

  try {
    audioBuffer = await raceWithAbort(
      audioContext.decodeAudioData(encodedAudio),
      signal,
    );
  } catch (error) {
    if (signal.aborted) {
      throw abortReason(signal);
    }

    throw new Error("The microphone recording could not be decoded.", {
      cause: error,
    });
  } finally {
    await audioContext.close().catch(() => {});
  }

  throwIfAborted(signal);

  if (
    audioBuffer.length <= 0 ||
    audioBuffer.numberOfChannels <= 0 ||
    !Number.isFinite(audioBuffer.duration) ||
    audioBuffer.duration <= 0
  ) {
    throw new Error("The decoded microphone recording was empty.");
  }

  return audioBuffer;
}

function validateDuration(durationSeconds: number) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new RangeError("durationSeconds must be a positive finite number.");
  }

  if (durationSeconds * 1_000 > maximumTimerDurationMs) {
    throw new RangeError("durationSeconds exceeds the supported timer range.");
  }
}

function reportProgress(
  onProgress: ((progress: number) => void) | undefined,
  progress: number,
) {
  onProgress?.(Math.max(0, Math.min(1, progress)));
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw abortReason(signal);
  }
}

function abortReason(signal: AbortSignal) {
  return (
    signal.reason ??
    new DOMException("Microphone capture was cancelled.", "AbortError")
  );
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) {
    return Promise.reject<T>(abortReason(signal));
  }

  return new Promise<T>((resolve, reject) => {
    const handleAbort = () => {
      reject(abortReason(signal));
    };

    signal.addEventListener("abort", handleAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", handleAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", handleAbort);
        reject(error);
      },
    );
  });
}
