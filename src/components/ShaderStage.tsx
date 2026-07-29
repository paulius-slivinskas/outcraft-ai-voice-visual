import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { ShaderClock } from "../lib/ShaderClock";
import { ShaderRenderer } from "../lib/ShaderRenderer";
import type { BlobConfig, MeshConfig } from "../types";

export type ShaderStageHandle = {
  captureThumbnail: (maxSize?: number, frame?: number) => string | null;
  getCanvas: (frame?: number) => HTMLCanvasElement | null;
  getCurrentMesh: () => MeshConfig;
};

type ShaderStageProps = {
  audioBands: number[];
  audioLevel: number;
  backgroundColor: string;
  blobs: BlobConfig[];
  clock?: ShaderClock;
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
    clock: providedClock,
    isPaused,
    mesh,
  }: ShaderStageProps,
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fallbackClockRef = useRef<ShaderClock | null>(null);
  const isPausedRef = useRef(isPaused);
  const meshRef = useRef(mesh);
  const rendererRef = useRef<ShaderRenderer | null>(null);
  fallbackClockRef.current ??= new ShaderClock(mesh.frame);
  const clock = providedClock ?? fallbackClockRef.current;

  function renderCurrentFrame(
    deltaMs = 0,
    nextAudioBands?: ArrayLike<number>,
    nextAudioLevel?: number,
    timestampMs = performance.now(),
    advanceClock = false,
    explicitFrame?: number,
  ) {
    const renderer = rendererRef.current;

    if (!renderer) {
      return false;
    }

    const activeMesh = meshRef.current;
    return renderer.renderAt(
      Number.isFinite(explicitFrame)
        ? explicitFrame!
        : advanceClock
          ? clock.tick(activeMesh.frame, activeMesh.speed, timestampMs)
          : clock.peek(activeMesh.frame),
      deltaMs,
      nextAudioBands,
      nextAudioLevel,
    );
  }

  useImperativeHandle(ref, () => ({
    captureThumbnail: (maxSize = 360, frame) => {
      const canvas = canvasRef.current;

      if (
        !canvas ||
        !renderCurrentFrame(
          0,
          undefined,
          undefined,
          performance.now(),
          false,
          frame,
        )
      ) {
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
    getCanvas: (frame) => {
      renderCurrentFrame(
        0,
        undefined,
        undefined,
        performance.now(),
        false,
        frame,
      );
      return canvasRef.current;
    },
    getCurrentMesh: () => ({
      ...meshRef.current,
      frame: clock.peek(meshRef.current.frame),
    }),
  }), [clock]);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const shaderRenderer = new ShaderRenderer({
      audioBands,
      audioLevel,
      backgroundColor,
      blobs,
      canvas,
      mesh,
      onContextStatusChange: (isContextLost) => {
        canvas.dataset.webglStatus = isContextLost ? "lost" : "ready";

        if (!isContextLost) {
          window.requestAnimationFrame(() => {
            renderCurrentFrame();
          });
        }
      },
      // ShaderStage exposes its DOM canvas for arbitrary PNG/thumbnail reads.
      // Dedicated export renderers do not need this and keep the engine default
      // (false), but this compatibility adapter must preserve the last frame.
      preserveDrawingBuffer: true,
    });
    rendererRef.current = shaderRenderer;
    canvas.dataset.webglStatus = "ready";

    const resize = () => {
      const { clientHeight, clientWidth } = canvas;

      if (clientWidth <= 0 || clientHeight <= 0) {
        return;
      }

      const didResize = shaderRenderer.setSize(
        clientWidth,
        clientHeight,
        Math.min(window.devicePixelRatio || 1, 2),
      );

      if (didResize) {
        renderCurrentFrame();
      }
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    window.addEventListener("resize", resize);
    resize();

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", resize);
      delete canvas.dataset.webglStatus;
      shaderRenderer.dispose();

      if (rendererRef.current === shaderRenderer) {
        rendererRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    isPausedRef.current = isPaused;

    if (isPaused) {
      clock.pause(meshRef.current.frame);
    }
  }, [clock, isPaused]);

  useEffect(() => {
    if (isPaused) {
      renderCurrentFrame();
      return;
    }

    let frameId = 0;
    let lastRenderTime: number | null = null;

    const render = (now: number) => {
      if (isPausedRef.current) {
        lastRenderTime = null;
        return;
      }

      const previousTime = lastRenderTime ?? now;
      const deltaMs = Math.max(0, now - previousTime);
      lastRenderTime = now;
      renderCurrentFrame(deltaMs, undefined, undefined, now, true);
      frameId = window.requestAnimationFrame(render);
    };

    frameId = window.requestAnimationFrame(render);

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [isPaused]);

  useEffect(() => {
    const renderer = rendererRef.current;

    if (!renderer) {
      return;
    }

    renderer.setBackgroundColor(backgroundColor);

    if (isPausedRef.current) {
      renderCurrentFrame();
    }
  }, [backgroundColor]);

  useEffect(() => {
    // Live audio is already normalized and attack/release-smoothed by the
    // shared analyser pipeline. Snapping avoids a second preview-only envelope.
    rendererRef.current?.setAudioTarget(audioBands, audioLevel, true);
  }, [audioBands, audioLevel]);

  useEffect(() => {
    meshRef.current = mesh;
    rendererRef.current?.setMesh(mesh);

    if (isPausedRef.current) {
      renderCurrentFrame();
    }
  }, [mesh]);

  useEffect(() => {
    rendererRef.current?.setBlobs(blobs);

    if (isPausedRef.current) {
      renderCurrentFrame();
    }
  }, [blobs]);

  return <canvas ref={canvasRef} className="shader-stage" aria-label="Mesh preview" />;
});

ShaderStage.displayName = "ShaderStage";
