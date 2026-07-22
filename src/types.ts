export type GradientStop = {
  color: string;
  offset: number;
};

export type GradientPreset = {
  name: string;
  stops: GradientStop[];
};

export type PaletteColor = {
  name: string;
  value: string;
};

export type ColorPalette = {
  colors: PaletteColor[];
  id: string;
  name: string;
};

export type OverlayAsset = "none" | "star" | "logo" | "waveform";

export type BottomRightOverlay = "button" | "qr" | "slogan";

export type OverlayTone = "light" | "dark";

export type CenterLogoSize = "33" | "50";

export type VisualOverlay = {
  asset: OverlayAsset;
  bottomRight: BottomRightOverlay;
  centerLogoOnly: boolean;
  centerLogoSize: CenterLogoSize;
  showBottomLeftSlogan: boolean;
  showBottomCta: boolean;
  showTopLogo: boolean;
  tone: OverlayTone;
};

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
  exportHeight?: number;
  exportWidth?: number;
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

export type VisualSnapshot = {
  backgroundColor: string;
  blobs: BlobConfig[];
  format: FormatConfig;
  id: string;
  mesh: MeshConfig;
  name: string;
  overlay: VisualOverlay;
  sectionId: string;
  thumbnail: string;
};
