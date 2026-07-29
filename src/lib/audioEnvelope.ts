export type AudioEnvelope = {
  attackTimeSeconds: number;
  releaseTimeSeconds: number;
};

/**
 * Canonical mapping for the 0..20 Audio Smoothness control.
 * Attack stays faster than release so transients remain responsive while
 * visual decay is stable. Preview and offline export both use this policy.
 */
export function getAudioEnvelope(audioSmoothness: number): AudioEnvelope {
  const smoothness = Math.max(
    0,
    Math.min(20, Number.isFinite(audioSmoothness) ? audioSmoothness : 5),
  );
  const normalized = smoothness / 20;
  const shaped = normalized ** 1.1;

  return {
    attackTimeSeconds: 0.025 + shaped * 0.25,
    releaseTimeSeconds: 0.08 + shaped * 0.57,
  };
}

export function getAudioEnvelopeAmount(
  deltaSeconds: number,
  timeSeconds: number,
) {
  if (timeSeconds <= 0) {
    return 1;
  }

  const safeDeltaSeconds = Math.max(
    0,
    Math.min(0.1, Number.isFinite(deltaSeconds) ? deltaSeconds : 0),
  );

  return 1 - Math.exp(-safeDeltaSeconds / timeSeconds);
}
