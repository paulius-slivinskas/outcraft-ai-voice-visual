import { useEffect, useMemo, useState } from "react";
import { ShaderStage } from "../components/ShaderStage";
import {
  initialBackgroundColor,
  initialBlobs,
  initialMesh,
  presetAudioReactivity,
  presetAudioSmoothness,
} from "../data/palette";
import { getOutcraftLogoDataUrl } from "../lib/brandAssets";
import type {
  BlobConfig,
  FormatConfig,
  GallerySection,
  MeshConfig,
  VisualOverlay,
  VisualSnapshot,
} from "../types";
import "./demo.css";

const rotationIntervalMs = 30000;
const signalIntervalMs = 100;
const logoLightSource = getOutcraftLogoDataUrl("light");
const logoDarkSource = getOutcraftLogoDataUrl("dark");

type DemoGalleryState = {
  items: VisualSnapshot[];
  sections: GallerySection[];
};

type AmbientSignal = {
  bands: number[];
  level: number;
};

const fallbackFormat: FormatConfig = {
  exportHeight: 1080,
  exportWidth: 1920,
  height: 9,
  label: "16:9",
  name: "1920 x 1080 px",
  width: 16,
};

const fallbackOverlay: VisualOverlay = {
  asset: "logo",
  bottomRight: "button",
  centerLogoOnly: true,
  centerLogoSize: "33",
  showBottomCta: false,
  showBottomLeftSlogan: false,
  showTopLogo: false,
  tone: "light",
};

const fallbackVisual: VisualSnapshot = {
  backgroundColor: initialBackgroundColor,
  blobs: initialBlobs,
  format: fallbackFormat,
  id: "outcraft-demo-fallback",
  mesh: initialMesh,
  name: "Outcraft Demo",
  overlay: fallbackOverlay,
  sectionId: "favorites",
  thumbnail: "",
};

export default function Demo() {
  const [visuals, setVisuals] = useState<VisualSnapshot[]>([fallbackVisual]);
  const [activeIndex, setActiveIndex] = useState(0);
  const signal = useAmbientSignal();
  const activeVisual = visuals[activeIndex % visuals.length] ?? fallbackVisual;
  const visual = useMemo(() => normalizeVisual(activeVisual), [activeVisual]);

  useEffect(() => {
    let isMounted = true;

    const loadGallery = async () => {
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}data/gallery.json`);
        const gallery = (await response.json()) as unknown;

        if (!isMounted || !isDemoGalleryState(gallery)) {
          return;
        }

        const galleryVisuals = gallery.items.filter(isVisualSnapshot);

        if (galleryVisuals.length > 0) {
          setVisuals(galleryVisuals);
          setActiveIndex(0);
        }
      } catch {
        if (isMounted) {
          setVisuals([fallbackVisual]);
        }
      }
    };

    void loadGallery();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (visuals.length < 2) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setActiveIndex((currentIndex) => (currentIndex + 1) % visuals.length);
    }, rotationIntervalMs);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [visuals.length]);

  return (
    <main className="demo-screen" aria-label="Outcraft demo visualizer">
      <div
        className="demo-visual-layer"
        data-visual-id={visual.id}
        key={visual.id}
      >
        <ShaderStage
          audioBands={signal.bands}
          audioLevel={signal.level}
          backgroundColor={visual.backgroundColor}
          blobs={visual.blobs}
          isPaused={false}
          mesh={visual.mesh}
        />
      </div>
      <div className="demo-vignette" aria-hidden="true" />
      <img
        alt=""
        aria-hidden="true"
        className="demo-center-logo demo-center-logo-shadow"
        src={logoDarkSource}
      />
      <img
        alt="Outcraft"
        className="demo-center-logo"
        src={logoLightSource}
      />
    </main>
  );
}

function useAmbientSignal() {
  const [signal, setSignal] = useState<AmbientSignal>(() => ({
    bands: Array(8).fill(0.18),
    level: 0.2,
  }));

  useEffect(() => {
    const startedAt = performance.now();
    const intervalId = window.setInterval(() => {
      const seconds = (performance.now() - startedAt) / 1000;
      const level =
        0.22 +
        0.12 * Math.sin(seconds * 0.86) +
        0.08 * Math.sin(seconds * 1.71 + 1.4);
      const bands = Array.from({ length: 8 }, (_, index) => {
        const phase = seconds * (0.62 + index * 0.075) + index * 0.92;
        const pulse = 0.5 + 0.5 * Math.sin(phase);
        const shimmer = 0.5 + 0.5 * Math.sin(seconds * 1.85 + index * 1.37);

        return clamp01(0.08 + pulse * 0.28 + shimmer * 0.14);
      });

      setSignal({
        bands,
        level: clamp01(level),
      });
    }, signalIntervalMs);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  return signal;
}

function normalizeVisual(visual: VisualSnapshot): VisualSnapshot {
  return {
    ...fallbackVisual,
    ...visual,
    backgroundColor:
      typeof visual.backgroundColor === "string"
        ? visual.backgroundColor
        : fallbackVisual.backgroundColor,
    blobs:
      Array.isArray(visual.blobs) && visual.blobs.length > 0
        ? visual.blobs.map(normalizeBlob)
        : fallbackVisual.blobs,
    format: normalizeFormat(visual.format),
    mesh: normalizeMesh(visual.mesh),
    overlay: fallbackOverlay,
  };
}

function normalizeBlob(blob: BlobConfig, index: number): BlobConfig {
  const fallbackBlob = fallbackVisual.blobs[index % fallbackVisual.blobs.length];

  return {
    ...fallbackBlob,
    ...blob,
    bend: finiteNumber(blob.bend, fallbackBlob.bend),
    opacity: finiteNumber(blob.opacity, fallbackBlob.opacity),
    rotation: finiteNumber(blob.rotation, fallbackBlob.rotation),
    size: finiteNumber(blob.size, fallbackBlob.size),
    stretch: finiteNumber(blob.stretch, fallbackBlob.stretch),
    taper: finiteNumber(blob.taper, fallbackBlob.taper),
    x: finiteNumber(blob.x, fallbackBlob.x),
    y: finiteNumber(blob.y, fallbackBlob.y),
  };
}

function normalizeFormat(format: FormatConfig): FormatConfig {
  return {
    ...fallbackFormat,
    ...format,
    height: finiteNumber(format.height, fallbackFormat.height),
    width: finiteNumber(format.width, fallbackFormat.width),
  };
}

function normalizeMesh(mesh: MeshConfig): MeshConfig {
  return {
    ...fallbackVisual.mesh,
    ...mesh,
    audioReactivity: presetAudioReactivity,
    audioSmoothness: presetAudioSmoothness,
    distortion: finiteNumber(mesh.distortion, initialMesh.distortion),
    frame: finiteNumber(mesh.frame, initialMesh.frame),
    grainMixer: finiteNumber(mesh.grainMixer, initialMesh.grainMixer),
    grainOverlay: finiteNumber(mesh.grainOverlay, initialMesh.grainOverlay),
    idleWarp: finiteNumber(mesh.idleWarp, initialMesh.idleWarp),
    motionBlur: finiteNumber(mesh.motionBlur, initialMesh.motionBlur),
    scale: finiteNumber(mesh.scale, initialMesh.scale),
    speed: Math.max(0.12, finiteNumber(mesh.speed, initialMesh.speed)),
    swirl: finiteNumber(mesh.swirl, initialMesh.swirl),
  };
}

function isDemoGalleryState(value: unknown): value is DemoGalleryState {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    Array.isArray(value.sections)
  );
}

function isVisualSnapshot(value: unknown): value is VisualSnapshot {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.backgroundColor === "string" &&
    Array.isArray(value.blobs) &&
    isRecord(value.mesh)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finiteNumber(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}
