/**
 * One allocation-free procedural clock shared by every preview aspect ratio.
 * requestAnimationFrame callbacks in the same browser frame receive the same
 * timestamp, so the first reader advances the clock and every other preview
 * observes exactly the same phase.
 */
export class ShaderClock {
  private baseFrame: number;
  private currentFrame: number;
  private lastTimestampMs: number | null = null;

  constructor(initialFrame: number) {
    const safeFrame = finiteOr(initialFrame, 0);
    this.baseFrame = safeFrame;
    this.currentFrame = safeFrame;
  }

  tick(
    baseFrame: number,
    speed: number,
    timestampMs: number,
  ) {
    const safeTimestampMs = finiteOr(timestampMs, performance.now());
    this.syncBase(baseFrame);

    if (
      this.lastTimestampMs !== null &&
      safeTimestampMs <= this.lastTimestampMs
    ) {
      return this.currentFrame;
    }

    if (this.lastTimestampMs !== null) {
      const deltaMs = Math.max(
        0,
        Math.min(100, safeTimestampMs - this.lastTimestampMs),
      );
      this.currentFrame += deltaMs * finiteOr(speed, 0);
    }

    this.lastTimestampMs = safeTimestampMs;
    return this.currentFrame;
  }

  peek(baseFrame: number) {
    this.syncBase(baseFrame);
    return this.currentFrame;
  }

  pause(baseFrame: number) {
    this.syncBase(baseFrame);
    this.lastTimestampMs = null;
    return this.currentFrame;
  }

  private syncBase(baseFrame: number) {
    const safeBaseFrame = finiteOr(baseFrame, this.baseFrame);

    if (safeBaseFrame !== this.baseFrame) {
      this.baseFrame = safeBaseFrame;
      this.currentFrame = safeBaseFrame;
      this.lastTimestampMs = null;
    }
  }
}

function finiteOr(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}
