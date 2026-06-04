export type BlobConfig = {
  bend: number;
  color: string;
  id: string;
  name: string;
  opacity: number;
  rotation: number;
  size: number;
  stretch: number;
  taper: number;
  x: number;
  y: number;
};

export type MeshConfig = {
  audioReactivity: number;
  audioSmoothness: number;
  distortion: number;
  frame: number;
  grainMixer: number;
  grainOverlay: number;
  idleWarp: number;
  motionBlur: number;
  scale: number;
  speed: number;
  swirl: number;
};

export type FormatConfig = {
  exportHeight: number;
  exportWidth: number;
  height: number;
  label: string;
  name: string;
  width: number;
};

export type GallerySection = {
  id: string;
  isOpen: boolean;
  name: string;
};

export type StaticVisualSnapshot = {
  backgroundColor: string;
  blobs: BlobConfig[];
  format: FormatConfig;
  id: string;
  mesh: MeshConfig;
  name: string;
  sectionId: string;
};

export type GalleryState = {
  items: StaticVisualSnapshot[];
  sections: GallerySection[];
};

export type InsertVisualMessage = {
  bytes: Uint8Array;
  height: number;
  name: string;
  type: "insert-visual";
  width: number;
};

export type PluginUiMessage =
  | InsertVisualMessage
  | { message: string; type: "notify" };

export type PluginMainMessage =
  | { type: "insert-complete" }
  | { message: string; type: "insert-error" };
