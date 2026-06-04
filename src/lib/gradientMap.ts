import {
  CanvasTexture,
  ClampToEdgeWrapping,
  LinearFilter,
  LinearSRGBColorSpace,
} from "three";
import type { GradientStop } from "../types";

export function createGradientMap(stops: GradientStop[], width = 512) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = 1;

  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Could not create gradient canvas context");
  }

  paintGradient(context, stops, width);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = LinearSRGBColorSpace;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;

  return { canvas, texture };
}

export function updateGradientMap(
  canvas: HTMLCanvasElement,
  texture: CanvasTexture,
  stops: GradientStop[],
) {
  const context = canvas.getContext("2d");

  if (!context) {
    return;
  }

  paintGradient(context, stops, canvas.width);
  texture.needsUpdate = true;
}

function paintGradient(
  context: CanvasRenderingContext2D,
  stops: GradientStop[],
  width: number,
) {
  const gradient = context.createLinearGradient(0, 0, width, 0);

  stops.forEach((stop) => {
    gradient.addColorStop(stop.offset, stop.color);
  });

  context.fillStyle = gradient;
  context.fillRect(0, 0, width, 1);
}
