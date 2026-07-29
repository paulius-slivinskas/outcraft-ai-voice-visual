export async function loadAudioBuffer(
  sourceUrl: string,
  signal: AbortSignal,
): Promise<AudioBuffer> {
  throwIfAborted(signal);

  const response = await fetch(sourceUrl, { signal });

  if (!response.ok) {
    throw new Error(`Could not read the selected audio file (${response.status}).`);
  }

  const encodedAudio = await response.arrayBuffer();
  throwIfAborted(signal);

  const audioContext = new AudioContext();

  try {
    const audioBuffer = await audioContext.decodeAudioData(encodedAudio);
    throwIfAborted(signal);

    if (!Number.isFinite(audioBuffer.duration) || audioBuffer.duration <= 0) {
      throw new Error("The selected audio file has no decodable audio.");
    }

    return audioBuffer;
  } catch (error) {
    if (signal.aborted) {
      throw signal.reason ?? new DOMException("Export cancelled.", "AbortError");
    }

    throw new Error("The selected audio file could not be decoded.", {
      cause: error,
    });
  } finally {
    await audioContext.close().catch(() => {});
  }
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("Export cancelled.", "AbortError");
  }
}
