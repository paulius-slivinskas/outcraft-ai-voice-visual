import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import {
  Color,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector4,
  WebGLRenderer,
} from "three";
import { ambientFragmentShader } from "../shaders/ambientFragment";
import { ambientVertexShader } from "../shaders/ambientVertex";
import type { BlobConfig, MeshConfig } from "../types";

export type ShaderStageHandle = {
  capturePng: (scale?: number) => string | null;
  captureThumbnail: (maxSize?: number) => string | null;
  getCanvas: () => HTMLCanvasElement | null;
  getCurrentMesh: () => MeshConfig;
  renderExportFrame: (
    nextAudioBands: number[],
    nextAudioLevel: number,
    deltaMs?: number,
  ) => void;
};

type ShaderStageProps = {
  audioBands: number[];
  audioLevel: number;
  backgroundColor: string;
  blobs: BlobConfig[];
  isPaused: boolean;
  mesh: MeshConfig;
};

export const ShaderStage = forwardRef<ShaderStageHandle, ShaderStageProps>(
function ShaderStage(
  {
    audioBands,
    audioLevel,
    backgroundColor,
    blobs,
    isPaused,
    mesh,
  }: ShaderStageProps,
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraRef = useRef<OrthographicCamera | null>(null);
  const materialRef = useRef<ShaderMaterial | null>(null);
  const rendererRef = useRef<WebGLRenderer | null>(null);
  const sceneRef = useRef<Scene | null>(null);
  const elapsedFrameRef = useRef(0);
  const isPausedRef = useRef(isPaused);
  const lastRenderTimeRef = useRef<number | null>(null);
  const meshRef = useRef(mesh);
  const previousFrameRef = useRef(mesh.frame);
  const smoothedAudioBandsRef = useRef(createAudioBands(audioBands));
  const smoothedAudioLevelRef = useRef(audioLevel);
  const targetAudioBandsRef = useRef(createAudioBands(audioBands));
  const targetAudioLevelRef = useRef(audioLevel);

  useImperativeHandle(ref, () => ({
    capturePng: (scale = 1) => {
      const canvas = canvasRef.current;

      if (!canvas) {
        return null;
      }

      if (scale <= 1) {
        return canvas.toDataURL("image/png");
      }

      const exportCanvas = document.createElement("canvas");
      exportCanvas.width = Math.max(1, Math.round(canvas.width * scale));
      exportCanvas.height = Math.max(1, Math.round(canvas.height * scale));

      const context = exportCanvas.getContext("2d");

      if (!context) {
        return null;
      }

      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(canvas, 0, 0, exportCanvas.width, exportCanvas.height);
      return exportCanvas.toDataURL("image/png");
    },
    captureThumbnail: (maxSize = 360) => {
      const canvas = canvasRef.current;

      if (!canvas) {
        return null;
      }

      const scale = Math.min(maxSize / canvas.width, maxSize / canvas.height, 1);
      const thumbnail = document.createElement("canvas");
      thumbnail.width = Math.max(1, Math.round(canvas.width * scale));
      thumbnail.height = Math.max(1, Math.round(canvas.height * scale));

      const context = thumbnail.getContext("2d");

      if (!context) {
        return null;
      }

      context.drawImage(canvas, 0, 0, thumbnail.width, thumbnail.height);
      return thumbnail.toDataURL("image/png");
    },
    getCanvas: () => canvasRef.current,
    getCurrentMesh: () => ({
      ...meshRef.current,
      frame: meshRef.current.frame + elapsedFrameRef.current,
    }),
    renderExportFrame: (nextAudioBands, nextAudioLevel, deltaMs = 0) => {
      const camera = cameraRef.current;
      const material = materialRef.current;
      const renderer = rendererRef.current;
      const scene = sceneRef.current;

      if (!camera || !material || !renderer || !scene) {
        return;
      }

      const activeMesh = meshRef.current;
      const safeDeltaMs = Number.isFinite(deltaMs)
        ? Math.max(0, Math.min(deltaMs, 100))
        : 0;

      elapsedFrameRef.current += safeDeltaMs * activeMesh.speed;
      const smoothing = getAudioSmoothing(safeDeltaMs, activeMesh.audioSmoothness ?? 5);
      targetAudioBandsRef.current = createAudioBands(nextAudioBands);
      targetAudioLevelRef.current = Math.max(0, Math.min(1, nextAudioLevel));
      smoothedAudioBandsRef.current = smoothAudioBands(
        smoothedAudioBandsRef.current,
        targetAudioBandsRef.current,
        smoothing,
      );
      smoothedAudioLevelRef.current +=
        (targetAudioLevelRef.current - smoothedAudioLevelRef.current) * smoothing;
      material.uniforms.uAudioBands.value = smoothedAudioBandsRef.current;
      material.uniforms.uAudioLevel.value = smoothedAudioLevelRef.current;
      material.uniforms.uTime.value =
        (activeMesh.frame + elapsedFrameRef.current) * 0.001;
      renderer.render(scene, camera);
    },
  }), []);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const renderer = new WebGLRenderer({
      alpha: false,
      antialias: true,
      canvas,
      powerPreference: "high-performance",
      preserveDrawingBuffer: true,
    });

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const scene = new Scene();
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const geometry = new PlaneGeometry(2, 2);
    const safeBlobs = createShaderBlobs(blobs);

    const material = new ShaderMaterial({
      fragmentShader: ambientFragmentShader,
      uniforms: {
        uBackgroundColor: { value: new Color(backgroundColor) },
        uAudioBands: { value: createAudioBands(audioBands) },
        uAudioLevel: { value: audioLevel },
        uAudioReactivity: { value: mesh.audioReactivity ?? 5.5 },
        uBlobColors: { value: safeBlobs.map((blob) => new Color(blob.color)) },
        uBlobShapes: { value: safeBlobs.map(blobShapeVector) },
        uBlobTransforms: { value: safeBlobs.map(blobTransformVector) },
        uMeshParams: { value: meshParamsVector(mesh) },
        uMeshScale: { value: mesh.scale },
        uIdleWarp: { value: mesh.idleWarp },
        uMotionBlur: { value: mesh.motionBlur },
        uResolution: { value: new Vector2(1, 1) },
        uTime: { value: mesh.frame * 0.001 },
      },
      vertexShader: ambientVertexShader,
    });

    materialRef.current = material;
    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;
    scene.add(new Mesh(geometry, material));

    const resize = () => {
      const { clientHeight, clientWidth } = canvas;
      renderer.setSize(clientWidth, clientHeight, false);
      material.uniforms.uResolution.value.set(clientWidth, clientHeight);
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    resize();

    let frameId = 0;

    const render = (now: number) => {
      const activeMesh = meshRef.current;
      const lastRenderTime = lastRenderTimeRef.current ?? now;
      const delta = now - lastRenderTime;
      lastRenderTimeRef.current = now;

      if (!isPausedRef.current) {
        elapsedFrameRef.current += delta * activeMesh.speed;
      }

      const smoothing = getAudioSmoothing(delta, activeMesh.audioSmoothness ?? 5);
      smoothedAudioBandsRef.current = smoothAudioBands(
        smoothedAudioBandsRef.current,
        targetAudioBandsRef.current,
        smoothing,
      );
      smoothedAudioLevelRef.current +=
        (targetAudioLevelRef.current - smoothedAudioLevelRef.current) * smoothing;
      material.uniforms.uAudioBands.value = smoothedAudioBandsRef.current;
      material.uniforms.uAudioLevel.value = smoothedAudioLevelRef.current;
      material.uniforms.uTime.value =
        (activeMesh.frame + elapsedFrameRef.current) * 0.001;
      renderer.render(scene, camera);
      frameId = requestAnimationFrame(render);
    };

    frameId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      materialRef.current = null;
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
    };
  }, []);

  useEffect(() => {
    const material = materialRef.current;

    if (!material) {
      return;
    }

    material.uniforms.uBackgroundColor.value.set(backgroundColor);
  }, [backgroundColor]);

  useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);

  useEffect(() => {
    const material = materialRef.current;

    if (!material) {
      return;
    }

    targetAudioLevelRef.current = Math.max(0, Math.min(1, audioLevel));
  }, [audioLevel]);

  useEffect(() => {
    targetAudioBandsRef.current = createAudioBands(audioBands);
  }, [audioBands]);

  useEffect(() => {
    const material = materialRef.current;

    if (mesh.frame !== previousFrameRef.current) {
      elapsedFrameRef.current = 0;
      previousFrameRef.current = mesh.frame;
    }

    meshRef.current = mesh;

    if (!material) {
      return;
    }

    material.uniforms.uMeshParams.value.copy(meshParamsVector(mesh));
    material.uniforms.uMeshScale.value = mesh.scale;
    material.uniforms.uIdleWarp.value = mesh.idleWarp;
    material.uniforms.uAudioReactivity.value = mesh.audioReactivity ?? 5.5;
    material.uniforms.uMotionBlur.value = mesh.motionBlur;
  }, [mesh]);

  useEffect(() => {
    const material = materialRef.current;

    if (!material) {
      return;
    }

    const safeBlobs = createShaderBlobs(blobs);
    material.uniforms.uBlobColors.value = safeBlobs.map((blob) => new Color(blob.color));
    material.uniforms.uBlobShapes.value = safeBlobs.map(blobShapeVector);
    material.uniforms.uBlobTransforms.value = safeBlobs.map(blobTransformVector);
  }, [blobs]);

  return <canvas ref={canvasRef} className="shader-stage" aria-label="Mesh preview" />;
});

ShaderStage.displayName = "ShaderStage";

function createShaderBlobs(blobs: BlobConfig[]) {
  const fallback = blobs[0] ?? {
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

  const sourceBlobs = blobs.length > 0 ? blobs : [fallback];

  return Array.from({ length: 8 }, (_, index) => {
    const sourceBlob = sourceBlobs[index % sourceBlobs.length] ?? fallback;
    const t = index / 7;

    return {
      ...sourceBlob,
      bend: sourceBlob.bend * 0.35,
      id: `${sourceBlob.id}-shader-${index}`,
      opacity: 0.54 + (sourceBlob.opacity - 0.54) * 0.55,
      rotation: -0.04 + 0.08 * t,
      size: 0.24 + 0.05 * Math.sin(index * 1.7),
      stretch: 2.2 + 0.55 * Math.sin(index * 1.2),
      taper: sourceBlob.taper * 0.3,
      x: 0.1 + t * 0.8,
      y: 0.5 + Math.sin(index * 1.55) * 0.035,
    };
  });
}

function blobShapeVector(blob: BlobConfig) {
  return new Vector4(blob.x, blob.y, blob.size, blob.opacity);
}

function blobTransformVector(blob: BlobConfig) {
  return new Vector4(blob.stretch, blob.rotation, blob.bend, blob.taper);
}

function meshParamsVector(mesh: MeshConfig) {
  return new Vector4(
    mesh.distortion,
    mesh.swirl,
    mesh.grainMixer,
    mesh.grainOverlay,
  );
}

function createAudioBands(audioBands: number[]) {
  return Array.from({ length: 8 }, (_, index) =>
    Math.max(0, Math.min(1, audioBands[index] ?? 0)),
  );
}

function getAudioSmoothing(deltaMs: number, audioSmoothness: number) {
  const safeDeltaMs = Number.isFinite(deltaMs)
    ? Math.max(0, Math.min(deltaMs, 100))
    : 16.67;
  const smoothness = Math.max(0, Math.min(20, audioSmoothness));
  const timeConstantMs = 80 + smoothness * 45;

  return 1 - Math.exp(-safeDeltaMs / timeConstantMs);
}

function smoothAudioBands(
  currentBands: number[],
  targetBands: number[],
  smoothing: number,
) {
  return Array.from({ length: 8 }, (_, index) => {
    const currentBand = currentBands[index] ?? 0;
    const targetBand = targetBands[index] ?? 0;
    const bandSmoothing = targetBand > currentBand ? smoothing * 0.78 : smoothing * 1.18;

    return currentBand + (targetBand - currentBand) * Math.max(0, Math.min(1, bandSmoothing));
  });
}
