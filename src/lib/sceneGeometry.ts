export const SCENE_HORIZONTAL_PADDING_RATIO = 0.06;

export function getSceneHorizontalPadding(
  width: number,
  pixelScale = 1,
) {
  const safeWidth = Math.max(1, finiteOr(width, 1));
  const safePixelScale = Math.max(
    1,
    Math.round(finiteOr(pixelScale, 1)),
  );
  const logicalWidth = safeWidth / safePixelScale;

  return (
    Math.round(logicalWidth * SCENE_HORIZONTAL_PADDING_RATIO) *
    safePixelScale
  );
}

export function getSceneContentWidth(
  width: number,
  pixelScale = 1,
) {
  const safeWidth = Math.max(1, finiteOr(width, 1));
  const horizontalPadding = getSceneHorizontalPadding(
    safeWidth,
    pixelScale,
  );

  return Math.max(1, safeWidth - horizontalPadding * 2);
}

function finiteOr(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}
