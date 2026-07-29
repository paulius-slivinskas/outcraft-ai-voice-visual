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
import {
  getAudioEnvelope,
  getAudioEnvelopeAmount,
} from "./audioEnvelope";
import { createShaderBlobChain } from "./shaderBlobChain";

const audioBandCount = 8;
const shaderBlobCount = 8;

export type ShaderRendererOptions = {
  audioBands: ArrayLike<number>;
  audioLevel: number;
  backgroundColor: string;
  blobs: readonly BlobConfig[];
  canvas: HTMLCanvasElement;
  mesh: MeshConfig;
  onContextStatusChange?: (isContextLost: boolean) => void;
  preserveDrawingBuffer?: boolean;
  releaseContextOnDispose?: boolean;
};

/**
 * Owns one complete Three/WebGL shader pipeline.
 *
 * Time is supplied as an absolute value on every render. The renderer never
 * starts its own clock or animation loop, which keeps preview and export
 * scheduling outside the GPU resource layer.
 */
export class ShaderRenderer {
  readonly canvas: HTMLCanvasElement;

  private readonly audioBands = new Float32Array(audioBandCount);
  private audioLevel = 0;
  private audioSmoothness = 5;
  private readonly blobColors = Array.from(
    { length: shaderBlobCount },
    () => new Color(),
  );
  private readonly blobShapes = Array.from(
    { length: shaderBlobCount },
    () => new Vector4(),
  );
  private readonly blobTransforms = Array.from(
    { length: shaderBlobCount },
    () => new Vector4(),
  );
  private readonly camera: OrthographicCamera;
  private contextLost = false;
  private disposed = false;
  private drawingHeight = 0;
  private drawingWidth = 0;
  private readonly geometry: PlaneGeometry;
  private logicalHeight = 0;
  private logicalWidth = 0;
  private readonly material: ShaderMaterial;
  private readonly mesh: Mesh;
  private pixelRatio = 0;
  private readonly renderer: WebGLRenderer;
  private readonly releaseContextOnDispose: boolean;
  private readonly resolution = new Vector2(1, 1);
  private readonly scene: Scene;
  private readonly targetAudioBands = new Float32Array(audioBandCount);
  private targetAudioLevel = 0;

  private readonly handleContextLost = () => {
    this.contextLost = true;
    this.onContextStatusChange?.(true);
  };

  private readonly handleContextRestored = () => {
    this.contextLost = false;
    this.onContextStatusChange?.(false);
  };

  private readonly onContextStatusChange?: (isContextLost: boolean) => void;

  constructor({
    audioBands,
    audioLevel,
    backgroundColor,
    blobs,
    canvas,
    mesh,
    onContextStatusChange,
    preserveDrawingBuffer = false,
    releaseContextOnDispose = false,
  }: ShaderRendererOptions) {
    this.canvas = canvas;
    this.onContextStatusChange = onContextStatusChange;
    this.releaseContextOnDispose = releaseContextOnDispose;
    this.renderer = new WebGLRenderer({
      alpha: false,
      antialias: false,
      canvas,
      depth: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer,
      stencil: false,
    });
    this.scene = new Scene();
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.geometry = new PlaneGeometry(2, 2);
    this.material = new ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      fragmentShader: ambientFragmentShader,
      uniforms: {
        uAudioBands: { value: this.audioBands },
        uAudioLevel: { value: this.audioLevel },
        uAudioReactivity: { value: mesh.audioReactivity ?? 5.5 },
        uBackgroundColor: { value: new Color(backgroundColor) },
        uBlobColors: { value: this.blobColors },
        uBlobShapes: { value: this.blobShapes },
        uBlobTransforms: { value: this.blobTransforms },
        uIdleWarp: { value: mesh.idleWarp },
        uMeshParams: { value: new Vector4() },
        uMeshScale: { value: mesh.scale },
        uMotionBlur: { value: mesh.motionBlur },
        uResolution: { value: this.resolution },
        uTime: { value: mesh.frame * 0.001 },
      },
      vertexShader: ambientVertexShader,
    });
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);

    canvas.addEventListener("webglcontextlost", this.handleContextLost);
    canvas.addEventListener("webglcontextrestored", this.handleContextRestored);

    this.setBackgroundColor(backgroundColor);
    this.setBlobs(blobs);
    this.setMesh(mesh);
    this.setAudioTarget(audioBands, audioLevel, true);
  }

  get isDisposed() {
    return this.disposed;
  }

  get isContextLost() {
    if (this.contextLost || this.disposed) {
      return true;
    }

    return this.renderer.getContext().isContextLost();
  }

  get size() {
    return {
      drawingHeight: this.drawingHeight,
      drawingWidth: this.drawingWidth,
      height: this.logicalHeight,
      pixelRatio: this.pixelRatio,
      width: this.logicalWidth,
    };
  }

  setSize(width: number, height: number, pixelRatio = 1) {
    if (this.disposed) {
      return false;
    }

    const safeWidth = Math.max(1, Math.round(finiteOr(width, 1)));
    const safeHeight = Math.max(1, Math.round(finiteOr(height, 1)));
    const safePixelRatio = Math.max(0.25, finiteOr(pixelRatio, 1));

    if (
      safeWidth === this.logicalWidth &&
      safeHeight === this.logicalHeight &&
      safePixelRatio === this.pixelRatio
    ) {
      return false;
    }

    this.logicalWidth = safeWidth;
    this.logicalHeight = safeHeight;
    this.pixelRatio = safePixelRatio;
    this.drawingWidth = Math.max(1, Math.floor(safeWidth * safePixelRatio));
    this.drawingHeight = Math.max(1, Math.floor(safeHeight * safePixelRatio));

    this.renderer.setDrawingBufferSize(
      safeWidth,
      safeHeight,
      safePixelRatio,
    );
    this.resolution.set(this.drawingWidth, this.drawingHeight);
    return true;
  }

  setBackgroundColor(backgroundColor: string) {
    if (!this.disposed) {
      this.material.uniforms.uBackgroundColor.value.set(backgroundColor);
    }
  }

  setBlobs(blobs: readonly BlobConfig[]) {
    if (this.disposed) {
      return;
    }

    const blobChain = createShaderBlobChain(blobs);

    for (let index = 0; index < shaderBlobCount; index += 1) {
      const sourceBlob = blobChain[index] ?? fallbackBlob;

      this.blobColors[index].set(sourceBlob.color);
      this.blobShapes[index].set(
        clamp01(sourceBlob.x),
        clamp01(sourceBlob.y),
        Math.max(0.025, finiteOr(sourceBlob.size, fallbackBlob.size)),
        clamp01(sourceBlob.opacity),
      );
      this.blobTransforms[index].set(
        Math.max(0.12, finiteOr(sourceBlob.stretch, fallbackBlob.stretch)),
        finiteOr(sourceBlob.rotation, fallbackBlob.rotation),
        finiteOr(sourceBlob.bend, fallbackBlob.bend),
        finiteOr(sourceBlob.taper, fallbackBlob.taper),
      );
    }
  }

  setMesh(mesh: MeshConfig) {
    if (this.disposed) {
      return;
    }

    this.material.uniforms.uMeshParams.value.set(
      mesh.distortion,
      mesh.swirl,
      mesh.grainMixer,
      mesh.grainOverlay,
    );
    this.material.uniforms.uMeshScale.value = mesh.scale;
    this.material.uniforms.uIdleWarp.value = mesh.idleWarp;
    this.material.uniforms.uAudioReactivity.value = mesh.audioReactivity ?? 5.5;
    this.material.uniforms.uMotionBlur.value = mesh.motionBlur;
    this.audioSmoothness = Math.max(
      0,
      Math.min(20, finiteOr(mesh.audioSmoothness, 5)),
    );
  }

  setAudioTarget(
    audioBands: ArrayLike<number>,
    audioLevel: number,
    snapToTarget = false,
  ) {
    if (this.disposed) {
      return;
    }

    for (let index = 0; index < audioBandCount; index += 1) {
      const nextBand = clamp01(audioBands[index] ?? 0);
      this.targetAudioBands[index] = nextBand;

      if (snapToTarget) {
        this.audioBands[index] = nextBand;
      }
    }

    this.targetAudioLevel = clamp01(audioLevel);

    if (snapToTarget) {
      this.audioLevel = this.targetAudioLevel;
      this.material.uniforms.uAudioLevel.value = this.audioLevel;
    }
  }

  renderAt(
    timeMs: number,
    deltaMs = 0,
    audioBands?: ArrayLike<number>,
    audioLevel?: number,
  ) {
    if (this.isContextLost) {
      return false;
    }

    if (audioBands || audioLevel !== undefined) {
      this.setAudioTarget(
        audioBands ?? this.targetAudioBands,
        audioLevel ?? this.targetAudioLevel,
      );
    }

    this.updateSmoothedAudio(deltaMs);
    this.material.uniforms.uTime.value = finiteOr(timeMs, 0) * 0.001;
    this.renderer.render(this.scene, this.camera);
    return true;
  }

  dispose() {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.handleContextRestored);
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    this.renderer.dispose();
    if (this.releaseContextOnDispose) {
      // Detached export canvases are never reused. Explicitly return their
      // scarce WebGL context instead of waiting for non-deterministic GC.
      this.renderer.forceContextLoss();
    }
    // WebGL contexts can outlive detached canvases until GC. Shrinking the
    // drawing buffer releases the large color surface without forcing a
    // context loss (which would break React StrictMode's effect rehearsal).
    this.canvas.width = 1;
    this.canvas.height = 1;
  }

  private updateSmoothedAudio(deltaMs: number) {
    const envelope = getAudioEnvelope(this.audioSmoothness);
    const deltaSeconds = Math.max(0, finiteOr(deltaMs, 0)) / 1000;
    const attackAmount = getAudioEnvelopeAmount(
      deltaSeconds,
      envelope.attackTimeSeconds,
    );
    const releaseAmount = getAudioEnvelopeAmount(
      deltaSeconds,
      envelope.releaseTimeSeconds,
    );

    for (let index = 0; index < audioBandCount; index += 1) {
      const currentBand = this.audioBands[index];
      const targetBand = this.targetAudioBands[index];
      const amount =
        targetBand > currentBand ? attackAmount : releaseAmount;

      this.audioBands[index] =
        currentBand + (targetBand - currentBand) * amount;
    }

    const levelAmount =
      this.targetAudioLevel > this.audioLevel
        ? attackAmount
        : releaseAmount;
    this.audioLevel +=
      (this.targetAudioLevel - this.audioLevel) * levelAmount;
    this.material.uniforms.uAudioLevel.value = this.audioLevel;
  }
}

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

function clamp01(value: number) {
  return Math.max(0, Math.min(1, finiteOr(value, 0)));
}

function finiteOr(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}
