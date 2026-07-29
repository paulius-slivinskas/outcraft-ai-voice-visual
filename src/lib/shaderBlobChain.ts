import type { BlobConfig } from "../types";

const shaderBlobCount = 8;

type LegacyBlobReference = Pick<
  BlobConfig,
  "rotation" | "size" | "stretch" | "x" | "y"
>;

// Static Mesh 670 is the startup scene and the visual reference for the
// original renderer. The legacy renderer ignored these five saved fields when
// it expanded three controls into its eight-anchor chain. Treat them as
// compatibility neutrals, then apply bounded deltas so controls work without
// collapsing the branded chain back into three isolated blobs.
const legacyBlobReferences: readonly LegacyBlobReference[] = [
  { rotation: -0.02, size: 1.85, stretch: 2.8, x: 0.23, y: 0.52 },
  { rotation: 0.02, size: 0.88, stretch: 3, x: 0.47, y: 0.51 },
  { rotation: 0.01, size: 0.3, stretch: 2.7, x: 0.78, y: 0.53 },
];

const fallbackBlob: BlobConfig = {
  bend: 0,
  color: "#eeeeee",
  id: "fallback",
  name: "Blob",
  opacity: 0.5,
  rotation: 0,
  size: 0.3,
  stretch: 1,
  taper: 0,
  x: 0.5,
  y: 0.5,
};

export function createShaderBlobChain(
  blobs: readonly BlobConfig[],
): BlobConfig[] {
  const sourceBlobs = blobs.length > 0 ? blobs : [fallbackBlob];

  return Array.from({ length: shaderBlobCount }, (_, index) => {
    const sourceIndex = index % sourceBlobs.length;
    const source = sourceBlobs[sourceIndex] ?? fallbackBlob;
    const reference =
      legacyBlobReferences[sourceIndex % legacyBlobReferences.length] ??
      legacyBlobReferences[0];
    const progress = index / (shaderBlobCount - 1);
    const baseSize = 0.24 + 0.05 * Math.sin(index * 1.7);
    const baseStretch = 2.2 + 0.55 * Math.sin(index * 1.2);
    const baseRotation = -0.04 + 0.08 * progress;

    return {
      ...source,
      bend: finiteOr(source.bend, 0) * 0.35,
      id: `${source.id}-shader-${index}`,
      opacity: clamp01(
        0.54 + (finiteOr(source.opacity, 0.54) - 0.54) * 0.55,
      ),
      rotation:
        baseRotation +
        shortestAngle(
          finiteOr(source.rotation, reference.rotation) - reference.rotation,
        ) *
          0.2,
      size: Math.max(
        0.06,
        baseSize +
          clamp(
            (finiteOr(source.size, reference.size) - reference.size) * 0.045,
            -0.09,
            0.09,
          ),
      ),
      stretch: Math.max(
        0.35,
        baseStretch +
          clamp(
            (finiteOr(source.stretch, reference.stretch) -
              reference.stretch) *
              0.2,
            -0.5,
            0.5,
          ),
      ),
      taper: finiteOr(source.taper, 0) * 0.3,
      x: clamp01(
        0.1 +
          progress * 0.8 +
          (finiteOr(source.x, reference.x) - reference.x) * 0.075,
      ),
      y: clamp01(
        0.5 +
          Math.sin(index * 1.55) * 0.035 +
          (finiteOr(source.y, reference.y) - reference.y) * 0.16,
      ),
    };
  });
}

function shortestAngle(angle: number) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function finiteOr(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number) {
  return clamp(value, 0, 1);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
