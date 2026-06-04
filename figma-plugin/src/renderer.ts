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
import { ambientFragmentShader } from "../../src/shaders/ambientFragment";
import { ambientVertexShader } from "../../src/shaders/ambientVertex";
import type { BlobConfig, FormatConfig, MeshConfig, StaticVisualSnapshot } from "./types";

const emptyAudioBands = Array.from({ length: 8 }, () => 0);

export class AmbientStaticRenderer {
  private camera: OrthographicCamera;
  private geometry: PlaneGeometry;
  private material: ShaderMaterial;
  private mesh: Mesh;
  private renderer: WebGLRenderer;
  private scene: Scene;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({
      alpha: false,
      antialias: true,
      canvas,
      powerPreference: "high-performance",
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(1);

    this.scene = new Scene();
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.geometry = new PlaneGeometry(2, 2);
    this.material = new ShaderMaterial({
      fragmentShader: ambientFragmentShader,
      uniforms: {
        uAudioBands: { value: emptyAudioBands },
        uAudioLevel: { value: 0 },
        uAudioReactivity: { value: 0 },
        uBackgroundColor: { value: new Color("#01151e") },
        uBlobColors: { value: Array.from({ length: 8 }, () => new Color("#ffffff")) },
        uBlobShapes: { value: Array.from({ length: 8 }, () => new Vector4()) },
        uBlobTransforms: { value: Array.from({ length: 8 }, () => new Vector4()) },
        uIdleWarp: { value: 0 },
        uMeshParams: { value: new Vector4() },
        uMeshScale: { value: 1 },
        uMotionBlur: { value: 0 },
        uResolution: { value: new Vector2(1, 1) },
        uTime: { value: 0 },
      },
      vertexShader: ambientVertexShader,
    });
    this.mesh = new Mesh(this.geometry, this.material);
    this.scene.add(this.mesh);
  }

  render(
    visual: StaticVisualSnapshot,
    format: FormatConfig,
    options: {
      frame: number;
      height?: number;
      scale?: number;
      width?: number;
    },
  ) {
    const width = Math.max(
      1,
      Math.round(options.width ?? format.exportWidth * (options.scale ?? 1)),
    );
    const height = Math.max(
      1,
      Math.round(options.height ?? format.exportHeight * (options.scale ?? 1)),
    );
    const mesh = normalizeMesh(visual.mesh, options.frame);
    const blobs = createShaderBlobs(visual.blobs);

    this.renderer.setSize(width, height, false);
    this.material.uniforms.uAudioBands.value = emptyAudioBands;
    this.material.uniforms.uAudioLevel.value = 0;
    this.material.uniforms.uAudioReactivity.value = 0;
    this.material.uniforms.uBackgroundColor.value.set(visual.backgroundColor);
    this.material.uniforms.uBlobColors.value = blobs.map((blob) => new Color(blob.color));
    this.material.uniforms.uBlobShapes.value = blobs.map(blobShapeVector);
    this.material.uniforms.uBlobTransforms.value = blobs.map(blobTransformVector);
    this.material.uniforms.uIdleWarp.value = mesh.idleWarp;
    this.material.uniforms.uMeshParams.value.copy(meshParamsVector(mesh));
    this.material.uniforms.uMeshScale.value = mesh.scale;
    this.material.uniforms.uMotionBlur.value = mesh.motionBlur;
    this.material.uniforms.uResolution.value.set(width, height);
    this.material.uniforms.uTime.value = mesh.frame * 0.001;
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

export async function renderVisualPngBytes(
  visual: StaticVisualSnapshot,
  format: FormatConfig,
  options: { frame: number; scale: number },
) {
  const canvas = document.createElement("canvas");
  const renderer = new AmbientStaticRenderer(canvas);

  renderer.render(visual, format, options);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((nextBlob) => {
      if (nextBlob) {
        resolve(nextBlob);
        return;
      }

      reject(new Error("Could not export PNG."));
    }, "image/png");
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());

  renderer.dispose();
  return bytes;
}

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

function normalizeMesh(mesh: MeshConfig, frame: number): MeshConfig {
  return {
    ...mesh,
    audioReactivity: 0,
    frame: Number.isFinite(frame) ? Math.max(0, Math.min(500000, frame)) : 0,
    grainOverlay: 0,
  };
}
