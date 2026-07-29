import type { BlobConfig, ColorPalette, MeshConfig, PaletteColor } from "../types";

export const paletteGroups: ColorPalette[] = [
  {
    colors: [
      { name: "Paper White", value: "#f4f1f3" },
      { name: "Aqua", value: "#18c5d4" },
      { name: "Teal", value: "#0aaeba" },
      { name: "Hot Pink", value: "#f25aa8" },
      { name: "Coral", value: "#ff7a74" },
      { name: "Orange", value: "#ff9a4d" },
      { name: "Deep", value: "#01151e" },
      { name: "Slate", value: "#2f3a61" },
      { name: "Denim", value: "#3a4572" },
      { name: "Violet", value: "#897fd4" },
      { name: "Ink", value: "#03080f" },
      { name: "Navy", value: "#171d35" },
      { name: "Blue", value: "#5666cf" },
      { name: "Lilac", value: "#a681f4" },
      { name: "Acid", value: "#bbff00" },
      { name: "Mist", value: "#f0f7b3" },
      { name: "Paper", value: "#eeeeee" },
    ],
    id: "Outcraft Saturated",
    name: "Outcraft Saturated",
  },
  {
    colors: [
      { name: "Deep Navy", value: "#2a3b53" },
      { name: "Muted Violet Blue", value: "#66647f" },
      { name: "Soft Blue", value: "#7c88ab" },
      { name: "Light Desaturated Blue", value: "#9ea9c4" },
      { name: "Very Light Blue Grey", value: "#babed1" },
      { name: "Warm Pale Grey", value: "#dfd7da" },
    ],
    id: "Outcraft Soft",
    name: "Outcraft Soft",
  },
];

export const paletteColors: PaletteColor[] = paletteGroups[0].colors;

export const initialBackgroundColor = "#f4f1f3";
export const presetAudioReactivity = 45;
export const presetAudioSmoothness = 18;
export const fixedGrainMixer = 0.05;
export const fixedGrainOverlay = 0;

export const initialMesh: MeshConfig = {
  audioReactivity: presetAudioReactivity,
  audioSmoothness: presetAudioSmoothness,
  distortion: 0.54,
  frame: 428834.2979991424,
  grainMixer: fixedGrainMixer,
  grainOverlay: fixedGrainOverlay,
  idleWarp: 0.35,
  motionBlur: 0,
  scale: 0.92,
  speed: 0.92,
  swirl: 0.02,
};

export const initialBlobs: BlobConfig[] = [
  {
    bend: 0.12,
    color: "#18c5d4",
    id: "blob-a",
    name: "Anchor 1",
    opacity: 0.92,
    rotation: -0.02,
    size: 0.34,
    stretch: 2.8,
    taper: 0.02,
    x: 0.23,
    y: 0.52,
  },
  {
    bend: -0.18,
    color: "#f25aa8",
    id: "blob-b",
    name: "Anchor 2",
    opacity: 0.86,
    rotation: 0.02,
    size: 0.32,
    stretch: 3.0,
    taper: -0.04,
    x: 0.5,
    y: 0.48,
  },
  {
    bend: 0.24,
    color: "#ff9a4d",
    id: "blob-c",
    name: "Anchor 3",
    opacity: 0.78,
    rotation: 0.01,
    size: 0.3,
    stretch: 2.7,
    taper: 0.06,
    x: 0.78,
    y: 0.53,
  },
];
