import { ShaderStage, type ShaderStageHandle } from "./components/ShaderStage";
import { Button } from "./components/ui/button";
import { Slider } from "./components/ui/slider";
import {
  fixedGrainMixer,
  fixedGrainOverlay,
  initialBackgroundColor,
  initialBlobs,
  initialMesh,
  paletteGroups,
} from "./data/palette";
import { cn } from "./lib/utils";
import type {
  BlobConfig,
  BottomRightOverlay,
  FormatConfig,
  GallerySection,
  MeshConfig,
  OverlayTone,
  VisualSnapshot,
  VisualOverlay,
} from "./types";
import {
  AudioLines,
  Check,
  Heart,
  Mic,
  Moon,
  Minus,
  Palette,
  Pause,
  Play,
  Plus,
  Shuffle,
  SlidersHorizontal,
  Sun,
  Volume2,
} from "lucide-react";
import {
  type ChangeEvent,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

const singleFormatOptions = [
  { exportHeight: 1080, exportWidth: 1080, height: 1, label: "1:1", name: "1080 x 1080 px", width: 1 },
  { exportHeight: 1440, exportWidth: 1080, height: 4, label: "3:4", name: "1080 x 1440 px", width: 3 },
  { exportHeight: 1080, exportWidth: 1440, height: 3, label: "4:3", name: "1440 x 1080 px", width: 4 },
  { exportHeight: 1080, exportWidth: 1920, height: 9, label: "16:9", name: "1920 x 1080 px", width: 16 },
  { exportHeight: 1920, exportWidth: 1080, height: 16, label: "9:16", name: "1080 x 1920 px", width: 9 },
] as const;

const formatOptions = singleFormatOptions;
const meshFrameMax = 500000;
const frameScrubFramesPerPixel = 5;
const videoDurationOptions = [15, 30, 60] as const;
const defaultVisualOverlay: VisualOverlay = {
  asset: "waveform",
  bottomRight: "button",
  showBottomLeftSlogan: true,
  showBottomCta: false,
  showTopLogo: true,
  tone: "light",
};

type FormatOption = (typeof formatOptions)[number];
type SingleFormatOption = (typeof singleFormatOptions)[number];
type ActiveTab = "generate" | "gallery";
type VideoDuration = (typeof videoDurationOptions)[number];
type VideoExportFormat = "webm" | "mp4";
type VideoBitratePreset = "low" | "standard" | "high";
type VideoFrameRate = 30 | 60;
type VideoExportOptions = {
  bitratePreset: VideoBitratePreset;
  durationSeconds: VideoDuration;
  frameRate: VideoFrameRate;
  isLoopable: boolean;
};
type VideoExportProgress = {
  formatLabel: string;
  formatIndex: number;
  progress: number;
  totalFormats: number;
};
type GallerySaveStatus = "loading" | "saving" | "saved" | "error";
type MusicStatus = "idle" | "loading" | "playing";
type MicStatus = "idle" | "loading" | "listening";
type VoiceStatus = "idle" | "loading" | "playing";
type UiTheme = "light" | "dark";
type FrameShape = "pill" | "square" | "circle" | "dock";
type ExportTarget = {
  format: SingleFormatOption;
  handle: ShaderStageHandle;
};
type GalleryState = {
  items: VisualSnapshot[];
  sections: GallerySection[];
};

const galleryApiPath = "/api/gallery";
const legacyGalleryStorageKey = "outcraft.gallery.v1";
const themeStorageKey = "outcraft.ui-theme.v1";
const sampleAudioPath =
  "/audio/019e083a-6191-7000-b905-5d72c6a03184-1778254690727-af155e06-25ca-4c6b-89ce-577ba10962fd-stereo.mp3";
const focusedWaveformAmplitudeScale = 1;
const exportAudioLookaheadSeconds = 0.1;
const exportAudioBitsPerSecond = 96000;
const exportTailSilenceSeconds = 0.7;
const exportTailSilenceWindowSeconds = 8;
const exportTailSilencePeakThreshold = 0.018;

// Running peak tracker for star-profile modes — normalizes bars so full star forms at track peak.
let _starNormalizedPeak = 0.1;

// Precomputed star silhouette profile for each of the 32 half-bar positions (0=center, 31=edge).
// Derived from the actual SVG bezier curves: for each bar's x position, the normalized visible
// height of the star shape (fraction of container height, capped at 1.0).
const STAR_BAR_PROFILE: readonly number[] = (() => {
  // Upper-right bezier segments of the star path
  const bez1 = [[45.036, 2.046], [45.35, 13.29], [47.67, 21.64], [52.833, 27.237]] as const;
  const bez2 = [[52.833, 27.237], [57.963, 32.800], [66.058, 35.791], [77.964, 36.373]] as const;

  const evalBez = (p: readonly (readonly [number, number])[], t: number): [number, number] => {
    const u = 1 - t;
    return [
      u*u*u*p[0][0] + 3*u*u*t*p[1][0] + 3*u*t*t*p[2][0] + t*t*t*p[3][0],
      u*u*u*p[0][1] + 3*u*u*t*p[1][1] + 3*u*t*t*p[2][1] + t*t*t*p[3][1],
    ];
  };

  const solveT = (p: readonly (readonly [number, number])[], targetX: number): number => {
    let t = (targetX - p[0][0]) / (p[3][0] - p[0][0]);
    for (let i = 0; i < 12; i++) {
      const [x] = evalBez(p, t);
      const dx = 3 * (
        (1-t)*(1-t)*(p[1][0]-p[0][0]) +
        2*(1-t)*t*(p[2][0]-p[1][0]) +
        t*t*(p[3][0]-p[2][0])
      );
      const dt = dx === 0 ? 0 : (x - targetX) / dx;
      t = Math.max(0, Math.min(1, t - dt));
      if (Math.abs(dt) < 1e-7) break;
    }
    return t;
  };

  return Array.from({ length: 32 }, (_, i) => {
    // Each bar maps to SVG x in [40.5, 81] (full right half of star at mask-size 100%)
    const xSvg = 40.5 + i * (40.5 / 31);
    // Outside star's right boundary
    if (xSvg > 80.012) return 0;
    // Flat-top region (top tip): full height
    if (xSvg <= 45.036) return 1.0;
    // Short line segment from arm to right tip — nearly flat
    if (xSvg >= 77.964) {
      const yTop = 36.373 + (xSvg - 77.964) * (36.4727 - 36.373) / (80.012 - 77.964);
      return Math.max(0, (84 - 2 * yTop) / 84);
    }
    // Bezier arm segments
    const pts = xSvg <= 52.833 ? bez1 : bez2;
    const [, yTop] = evalBez(pts, solveT(pts, xSvg));
    return Math.min(1, Math.max(0, (84 - 2 * yTop) / 84));
  });
})();
const defaultGallerySection: GallerySection = {
  id: "favorites",
  isOpen: true,
  name: "Favorites",
};

function App() {
  const stageRef = useRef<ShaderStageHandle | null>(null);
  const formatStageRefs = useRef<Record<string, ShaderStageHandle | null>>({});
  const voiceAudioRef = useRef<HTMLAudioElement | null>(null);
  const musicAudioRef = useRef<HTMLAudioElement | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const musicAnalyserRef = useRef<AnalyserNode | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const voiceAnalyserRef = useRef<AnalyserNode | null>(null);
  const musicAudioContextRef = useRef<AudioContext | null>(null);
  const micAudioContextRef = useRef<AudioContext | null>(null);
  const voiceAudioContextRef = useRef<AudioContext | null>(null);
  const musicFrameRef = useRef(0);
  const micFrameRef = useRef(0);
  const voiceFrameRef = useRef(0);
  const audioObjectUrlRef = useRef<string | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const musicSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const voiceSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const hasLoadedGalleryRef = useRef(false);
  const isSavingGalleryRef = useRef(false);
  const grainMixerRef = useRef(normalizeMesh(initialMesh).grainMixer);
  const pendingGalleryStateRef = useRef<GalleryState | null>(null);
  const skipNextGallerySaveRef = useRef(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>("generate");
  const [activeGallerySectionId, setActiveGallerySectionId] = useState(
    defaultGallerySection.id,
  );
  const [uiTheme, setUiTheme] = useState<UiTheme>(readStoredTheme);
  const [backgroundColor, setBackgroundColor] = useState(initialBackgroundColor);
  const [activePaletteId, setActivePaletteId] = useState(paletteGroups[0].id);
  const [blobs, setBlobs] = useState(initialBlobs);
  const [galleryState, setGalleryState] =
    useState<GalleryState>(createDefaultGalleryState);
  const [gallerySaveStatus, setGallerySaveStatus] =
    useState<GallerySaveStatus>("loading");
  const [audioBands, setAudioBands] = useState<number[]>(() => Array(8).fill(0));
  const [audioSpectrum, setAudioSpectrum] = useState<number[]>(() => Array(64).fill(0));
  const [audioLevel, setAudioLevel] = useState(0);
  const [musicStatus, setMusicStatus] = useState<MusicStatus>("idle");
  const [micStatus, setMicStatus] = useState<MicStatus>("idle");
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("idle");
  const [voiceNotice, setVoiceNotice] = useState("");
  const [frameShape, setFrameShape] = useState<FrameShape>("square");
  const [mesh, setMesh] = useState(() => normalizeMesh(initialMesh));
  const [format, setFormat] = useState<FormatOption>(singleFormatOptions[0]);
  const [isPaused, setIsPaused] = useState(false);
  const [visualOverlay, setVisualOverlay] =
    useState<VisualOverlay>(defaultVisualOverlay);
  const [timelineFrame, setTimelineFrame] = useState(
    () => normalizeMesh(initialMesh).frame,
  );
  const [pausedFrame, setPausedFrame] = useState(
    () => normalizeMesh(initialMesh).frame,
  );
  const [frameOffset, setFrameOffset] = useState(0);
  const [isExportingVideo, setIsExportingVideo] = useState(false);
  const [videoBitratePreset, setVideoBitratePreset] =
    useState<VideoBitratePreset>("standard");
  const [videoDuration, setVideoDuration] = useState<VideoDuration>(15);
  const [videoExportFormat, setVideoExportFormat] =
    useState<VideoExportFormat>("mp4");
  const [videoFrameRate, setVideoFrameRate] = useState<VideoFrameRate>(30);
  const [isVideoLoopEnabled, setIsVideoLoopEnabled] = useState(false);
  const [selectedVisualId, setSelectedVisualId] = useState<string | null>(null);
  const [exportFormats, setExportFormats] = useState<Set<string>>(
    () => new Set([singleFormatOptions[0].label]),
  );
  const [audioSource, setAudioSource] = useState(sampleAudioPath);
  const [audioFileName, setAudioFileName] = useState("Default MP3");
  const [videoExportProgress, setVideoExportProgress] =
    useState<VideoExportProgress | null>(null);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [previewPan, setPreviewPan] = useState({ x: 0, y: 0 });
  const [isPreviewDragging, setIsPreviewDragging] = useState(false);
  const previewDragRef = useRef<{
    panX: number;
    panY: number;
    pointerId: number;
    startX: number;
    startY: number;
  } | null>(null);
  const exportCancelRef = useRef(false);
  const activeExportAudioRef = useRef<HTMLAudioElement | null>(null);
  const activeExportRecorderRef = useRef<MediaRecorder | null>(null);

  const gallery = galleryState.items;
  const gallerySections = galleryState.sections;
  const frameAudioColor = getAudioBandColor(audioBands, blobs);
  const frameAudioStyle = {
    "--frame-audio-color": frameAudioColor,
    "--frame-audio-level": audioLevel.toFixed(3),
    "--format-ratio": `${format.width / format.height}`,
    aspectRatio: `${format.width} / ${format.height}`,
  } as CSSProperties;
  const selectedPreviewFormats = singleFormatOptions.filter((option) =>
    exportFormats.has(option.label),
  );
  const visiblePreviewFormats =
    selectedPreviewFormats.length > 0 ? selectedPreviewFormats : [singleFormatOptions[0]];
  const primaryPreviewFormat =
    visiblePreviewFormats.find((option) => option.label === format.label) ??
    visiblePreviewFormats[0];
  const previewArtboardStyle = {
    "--preview-pan-x": `${previewPan.x}px`,
    "--preview-pan-y": `${previewPan.y}px`,
    "--preview-zoom": previewZoom.toFixed(2),
  } as CSSProperties;
  const recordingProgress = videoExportProgress
    ? Math.max(
        0,
        Math.min(
          1,
          (videoExportProgress.formatIndex + videoExportProgress.progress) /
            Math.max(1, videoExportProgress.totalFormats),
        ),
      )
    : 0;
  const recordingProgressPercent = Math.round(recordingProgress * 100);
  const recordingProgressStyle = {
    "--recording-progress": recordingProgress.toFixed(4),
  } as CSSProperties;

  const updatePreviewZoom = (delta: number) => {
    setPreviewZoom((currentZoom) =>
      Math.max(0.45, Math.min(2.5, Number((currentZoom + delta).toFixed(2)))),
    );
  };

  const cancelVideoExport = () => {
    exportCancelRef.current = true;
    activeExportAudioRef.current?.pause();

    const recorder = activeExportRecorderRef.current;

    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
  };

  const startPreviewDrag = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) {
      return;
    }

    if (
      event.target instanceof Element &&
      event.target.closest(".artboard-zoom-controls, button, input, select, textarea, label, a")
    ) {
      return;
    }

    previewDragRef.current = {
      panX: previewPan.x,
      panY: previewPan.y,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
    setIsPreviewDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const movePreviewDrag = (event: PointerEvent<HTMLElement>) => {
    const drag = previewDragRef.current;

    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    setPreviewPan({
      x: drag.panX + event.clientX - drag.startX,
      y: drag.panY + event.clientY - drag.startY,
    });
  };

  const stopPreviewDrag = (event: PointerEvent<HTMLElement>) => {
    const drag = previewDragRef.current;

    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    previewDragRef.current = null;
    setIsPreviewDragging(false);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const clearAudioMeters = () => {
    setAudioBands(Array(8).fill(0));
    setAudioSpectrum(Array(64).fill(0));
    setAudioLevel(0);
  };

  const setAudioElementSource = (audio: HTMLAudioElement, source: string) => {
    if (audio.dataset.source === source) {
      return;
    }

    audio.pause();
    audio.crossOrigin = source.startsWith("blob:") ? null : "anonymous";
    audio.src = source;
    audio.dataset.source = source;
    audio.load();
  };

  const handleAudioFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];

    if (!file) {
      return;
    }

    const nextAudioUrl = URL.createObjectURL(file);

    if (audioObjectUrlRef.current) {
      URL.revokeObjectURL(audioObjectUrlRef.current);
    }

    audioObjectUrlRef.current = nextAudioUrl;
    stopMusicPlayback();
    stopMicrophone();
    stopVoicePlayback();
    clearAudioMeters();
    setVoiceNotice("");
    setAudioSource(nextAudioUrl);
    setAudioFileName(file.name);

    if (musicAudioRef.current) {
      setAudioElementSource(musicAudioRef.current, nextAudioUrl);
    }

    if (voiceAudioRef.current) {
      setAudioElementSource(voiceAudioRef.current, nextAudioUrl);
    }

    event.currentTarget.value = "";
  };

  const toggleExportFormat = (option: SingleFormatOption) => {
    setFormat(option);
    setExportFormats((currentFormats) => {
      const nextFormats = new Set(currentFormats);

      if (nextFormats.has(option.label)) {
        nextFormats.delete(option.label);
      } else {
        nextFormats.add(option.label);
      }

      return nextFormats;
    });
  };

  const flushGallerySaveQueue = async () => {
    if (isSavingGalleryRef.current) {
      return;
    }

    isSavingGalleryRef.current = true;

    try {
      while (pendingGalleryStateRef.current) {
        const nextGalleryState = pendingGalleryStateRef.current;
        pendingGalleryStateRef.current = null;
        await writeGalleryState(nextGalleryState);
      }

      setGallerySaveStatus("saved");
    } catch {
      setGallerySaveStatus("error");
    } finally {
      isSavingGalleryRef.current = false;

      if (pendingGalleryStateRef.current) {
        void flushGallerySaveQueue();
      }
    }
  };

  const queueGallerySave = (nextGalleryState: GalleryState) => {
    pendingGalleryStateRef.current = nextGalleryState;
    setGallerySaveStatus("saving");
    void flushGallerySaveQueue();
  };

  const applyDefaultStartupScene = (nextGalleryState: GalleryState) => {
    const defaultAmbientVisual = findDefaultAmbientVisual(nextGalleryState.items);

    setFrameShape("square");
    setFormat(singleFormatOptions[0]);
    setVisualOverlay((currentOverlay) => ({
      ...currentOverlay,
      asset: "waveform",
      bottomRight: "button",
      showBottomLeftSlogan: true,
      showBottomCta: true,
      showTopLogo: true,
    }));

    if (!defaultAmbientVisual) {
      return;
    }

    const normalizedMesh = normalizeMesh(defaultAmbientVisual.mesh);
    setBackgroundColor(defaultAmbientVisual.backgroundColor);
    setBlobs(cloneBlobs(defaultAmbientVisual.blobs));
    grainMixerRef.current = normalizedMesh.grainMixer;
    setMesh(normalizedMesh);
    setTimelineFrame(normalizedMesh.frame);
    setPausedFrame(normalizedMesh.frame);
    setFrameOffset(0);
    setSelectedVisualId(defaultAmbientVisual.id);
  };

  useEffect(() => {
    writeStoredTheme(uiTheme);
  }, [uiTheme]);

  useEffect(() => {
    let isMounted = true;

    const loadGalleryState = async () => {
      try {
        const fileGalleryState = await readGalleryState();
        const legacyGalleryState = readLegacyGalleryState();
        const nextGalleryState = legacyGalleryState
          ? mergeGalleryStates(fileGalleryState, legacyGalleryState)
          : fileGalleryState;

        if (!isMounted) {
          return;
        }

        skipNextGallerySaveRef.current = legacyGalleryState === null;
        setGalleryState(nextGalleryState);
        applyDefaultStartupScene(nextGalleryState);
        hasLoadedGalleryRef.current = true;
        setGallerySaveStatus("saved");

        if (legacyGalleryState) {
          queueGallerySave(nextGalleryState);
        }
      } catch {
        const legacyGalleryState = readLegacyGalleryState();

        if (!isMounted) {
          return;
        }

        const fallbackGalleryState = legacyGalleryState ?? createDefaultGalleryState();
        setGalleryState(fallbackGalleryState);
        applyDefaultStartupScene(fallbackGalleryState);
        hasLoadedGalleryRef.current = true;
        setGallerySaveStatus("error");
      }
    };

    void loadGalleryState();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!hasLoadedGalleryRef.current) {
      return;
    }

    if (skipNextGallerySaveRef.current) {
      skipNextGallerySaveRef.current = false;
      return;
    }

    queueGallerySave(galleryState);
  }, [galleryState]);

  useEffect(() => {
    return () => {
      window.cancelAnimationFrame(musicFrameRef.current);
      window.cancelAnimationFrame(micFrameRef.current);
      window.cancelAnimationFrame(voiceFrameRef.current);
      musicAudioRef.current?.pause();
      voiceAudioRef.current?.pause();
      micStreamRef.current?.getTracks().forEach((track) => track.stop());
      void musicAudioContextRef.current?.close();
      void micAudioContextRef.current?.close();
      void voiceAudioContextRef.current?.close();

      if (audioObjectUrlRef.current) {
        URL.revokeObjectURL(audioObjectUrlRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (isPaused || isExportingVideo) {
      return;
    }

    let frameId = 0;
    let lastSyncTime = 0;

    const syncTimelineFrame = (now: number) => {
      if (now - lastSyncTime >= 100) {
        lastSyncTime = now;
        setTimelineFrame(
          clampFrame(stageRef.current?.getCurrentMesh().frame ?? mesh.frame),
        );
      }

      frameId = window.requestAnimationFrame(syncTimelineFrame);
    };

    frameId = window.requestAnimationFrame(syncTimelineFrame);

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [isExportingVideo, isPaused, mesh.frame]);

  const updateBlob = (
    blobId: string,
    property: keyof BlobConfig,
    value: number | string,
  ) => {
    setBlobs((currentBlobs) =>
      currentBlobs.map((blob) =>
        blob.id === blobId ? { ...blob, [property]: value } : blob,
      ),
    );
  };

  const updateMesh = (property: keyof MeshConfig, value: number) => {
    if (property === "grainOverlay") {
      return;
    }

    if (property === "grainMixer") {
      grainMixerRef.current = value;
    }

    if (property === "frame") {
      const nextFrame = clampFrame(value);
      setTimelineFrame(nextFrame);
      setPausedFrame(nextFrame);
      setFrameOffset(0);
      setMesh((currentMesh) => normalizeMesh({ ...currentMesh, frame: nextFrame }));
      return;
    }

    setMesh((currentMesh) => ({
      ...currentMesh,
      [property]: value,
      grainOverlay: fixedGrainOverlay,
    }));
  };

  const randomizeComposition = () => {
    const nextFrame = randomBetween(0, meshFrameMax);
    setTimelineFrame(nextFrame);
    setPausedFrame(nextFrame);
    setFrameOffset(0);
    setMesh((currentMesh) => ({
      ...currentMesh,
      distortion: randomBetween(0.28, 0.86),
      frame: nextFrame,
      grainMixer: grainMixerRef.current,
      grainOverlay: fixedGrainOverlay,
      scale: randomBetween(0.9, 1.55),
      swirl: randomBetween(0.02, 0.34),
    }));
    setBlobs((currentBlobs) =>
      currentBlobs.map((blob, index) => ({
        ...createRandomBlob(index),
        color: blob.color,
        id: blob.id,
        name: blob.name,
      })),
    );
  };

  const randomizeColors = () => {
    setBackgroundColor(randomPaletteColor(activePaletteId));
    setBlobs((currentBlobs) =>
      currentBlobs.map((blob) => ({
        ...blob,
        color: randomPaletteColor(activePaletteId),
      })),
    );
  };

  const togglePlayback = () => {
    const currentMesh = normalizeMesh(stageRef.current?.getCurrentMesh() ?? mesh);

    setMesh(currentMesh);
    setTimelineFrame(currentMesh.frame);
    setPausedFrame(currentMesh.frame);
    setFrameOffset(0);
    setIsPaused((currentValue) => !currentValue);
  };

  const scrubTimelineFrame = (nextValue: number) => {
    const nextFrame = clampFrame(nextValue);

    if (isPaused) {
      setFrameOffset(nextFrame - pausedFrame);
    } else {
      setPausedFrame(nextFrame);
      setFrameOffset(0);
    }

    setIsPaused(true);
    setTimelineFrame(nextFrame);
    setMesh((currentMesh) =>
      normalizeMesh({
        ...currentMesh,
        frame: nextFrame,
      }),
    );
  };

  const scrubFrame = (deltaFrames: number) => {
    if (!isPaused || deltaFrames === 0) {
      return;
    }

    setFrameOffset((currentOffset) => {
      const nextOffset = currentOffset + deltaFrames;
      const nextFrame = clampFrame(pausedFrame + nextOffset);

      setTimelineFrame(nextFrame);

      setMesh((currentMesh) =>
        normalizeMesh({
          ...currentMesh,
          frame: nextFrame,
        }),
      );

      return nextFrame - pausedFrame;
    });
  };

  const captureCurrentVisual = () => {
    const thumbnail = stageRef.current?.captureThumbnail();

    if (!thumbnail) {
      return null;
    }

    return {
      backgroundColor,
      blobs: cloneBlobs(blobs),
      format: cloneFormat(format),
      mesh: normalizeMesh(stageRef.current?.getCurrentMesh() ?? mesh),
      overlay: { ...visualOverlay },
      thumbnail,
    };
  };

  const saveCurrentVisual = () => {
    const visual = captureCurrentVisual();

    if (!visual) {
      return;
    }

    const snapshot: VisualSnapshot = {
      ...visual,
      id: crypto.randomUUID(),
      name: generateVisualName(),
      sectionId: getExistingSectionId(gallerySections, activeGallerySectionId),
    };

    setGalleryState((currentState) => ({
      ...currentState,
      items: [snapshot, ...currentState.items],
      sections: currentState.sections.map((section) =>
        section.id === snapshot.sectionId ? { ...section, isOpen: true } : section,
      ),
    }));
    setSelectedVisualId(snapshot.id);
  };

  const getExportTargets = (): ExportTarget[] => {
    return singleFormatOptions
      .filter((option) => exportFormats.has(option.label))
      .map((option) => {
        const handle = formatStageRefs.current[option.label] ?? stageRef.current;

        return handle ? { format: option, handle } : null;
      })
      .filter((target): target is ExportTarget => target !== null);
  };

  const exportPng = async (scale: 1 | 2) => {
    const targets = getExportTargets();

    if (targets.length === 0) {
      return;
    }

    const baseName = slugify(generateVisualName());

    for (const target of targets) {
      const dataUrl = await captureTargetPng(
        target.handle,
        scale,
        target.format,
      );

      if (!dataUrl) {
        continue;
      }

      downloadDataUrl(
        dataUrl,
        `${baseName}-${formatSlug(target.format)}-${scale}x.png`,
      );
    }
  };

  const exportVideo = async (videoFormat: VideoExportFormat) => {
    const targets = getExportTargets();

    if (targets.length === 0 || typeof MediaRecorder === "undefined") {
      window.alert("Video export is not supported in this browser.");
      return;
    }

    const mimeType = getSupportedVideoMimeType(videoFormat);

    if (!mimeType) {
      window.alert(`${videoFormat.toUpperCase()} export is not supported in this browser.`);
      return;
    }

    const baseName = slugify(generateVisualName());

    exportCancelRef.current = false;
    setIsExportingVideo(true);
    setVideoExportProgress(null);
    await waitForNextAnimationFrame();

    try {
      for (const [formatIndex, target] of targets.entries()) {
        if (exportCancelRef.current) {
          break;
        }

        setVideoExportProgress({
          formatIndex,
          formatLabel: target.format.label,
          progress: 0,
          totalFormats: targets.length,
        });
        await exportVideoTarget(target, baseName, videoFormat, mimeType, {
          bitratePreset: videoBitratePreset,
          durationSeconds: videoDuration,
          frameRate: videoFrameRate,
          isLoopable: isVideoLoopEnabled,
        }, (progress) => {
          setVideoExportProgress({
            formatIndex,
            formatLabel: target.format.label,
            progress,
            totalFormats: targets.length,
          });
        });
      }
    } catch {
      if (!exportCancelRef.current) {
        window.alert("Video export failed.");
      }
    } finally {
      setIsExportingVideo(false);
      setVideoExportProgress(null);
      exportCancelRef.current = false;
      activeExportAudioRef.current = null;
      activeExportRecorderRef.current = null;
    }
  };

  const exportVideoTarget = async (
    target: ExportTarget,
    baseName: string,
    videoFormat: VideoExportFormat,
    mimeType: string,
    options: VideoExportOptions,
    onProgress: (progress: number) => void,
  ) => {
    const canvas = target.handle.getCanvas();

    if (!canvas) {
      throw new Error("Video export is not supported in this browser.");
    }

    const recordingOverlay: VisualOverlay = {
      ...visualOverlay,
      asset: "waveform",
    };
    await waitForFontsReady();
    const overlayImage = await loadOverlayImage(recordingOverlay);
    const qrImage = recordingOverlay.showBottomCta && recordingOverlay.bottomRight === "qr"
      ? await loadQrCodeImage(recordingOverlay.tone)
      : null;
    const topLogoImage = recordingOverlay.showTopLogo ? await loadTopLogoImage(recordingOverlay) : null;
    const captureCanvas = document.createElement("canvas");
    captureCanvas.width = target.format.exportWidth ?? canvas.width;
    captureCanvas.height = target.format.exportHeight ?? canvas.height;

    const captureContext = captureCanvas.getContext("2d");

    if (!captureContext || typeof captureCanvas.captureStream !== "function") {
      throw new Error("Video export is not supported in this browser.");
    }

    const exportAudio = new Audio();
    activeExportAudioRef.current = exportAudio;
    setAudioElementSource(exportAudio, audioSource);
    exportAudio.preload = "auto";
    exportAudio.currentTime = 0;

    await new Promise<void>((resolve) => {
      const onReady = () => {
        exportAudio.removeEventListener("loadedmetadata", onReady);
        resolve();
      };
      if (Number.isFinite(exportAudio.duration) && exportAudio.duration > 0) {
        resolve();
      } else {
        exportAudio.addEventListener("loadedmetadata", onReady);
        exportAudio.load();
      }
    });

    const durationMs = Math.max(
      1000,
      Math.round((Number.isFinite(exportAudio.duration) ? exportAudio.duration : options.durationSeconds) * 1000),
    );

    if (exportCancelRef.current) {
      return;
    }

    const exportAudioContext = new AudioContext();
    const exportAnalyser = exportAudioContext.createAnalyser();
    exportAnalyser.fftSize = 256;
    exportAnalyser.smoothingTimeConstant = 0.48;
    const exportSource = exportAudioContext.createMediaElementSource(exportAudio);
    const exportAudioDelay = exportAudioContext.createDelay(exportAudioLookaheadSeconds + 0.05);
    const monoDestination = exportAudioContext.createMediaStreamDestination();
    const monoSplitter = exportAudioContext.createChannelSplitter(2);
    const monoLeftGain = exportAudioContext.createGain();
    const monoRightGain = exportAudioContext.createGain();
    const monoMerger = exportAudioContext.createChannelMerger(1);
    exportAudioDelay.delayTime.value = exportAudioLookaheadSeconds;
    monoDestination.channelCount = 1;
    monoDestination.channelCountMode = "explicit";
    monoLeftGain.gain.value = 0.5;
    monoRightGain.gain.value = 0.5;
    exportSource.connect(exportAnalyser);
    exportSource.connect(exportAudioDelay);
    exportAudioDelay.connect(monoSplitter);
    monoSplitter.connect(monoLeftGain, 0);
    monoSplitter.connect(monoRightGain, 1);
    monoLeftGain.connect(monoMerger, 0, 0);
    monoRightGain.connect(monoMerger, 0, 0);
    monoMerger.connect(monoDestination);
    const exportLevels = new Uint8Array(exportAnalyser.frequencyBinCount);
    let exportMeshSpectrum = Array(64).fill(0);
    let exportWaveformSpectrum = Array(64).fill(0);
    let exportBands = Array(8).fill(0);
    let exportLevel = 0;
    let loopStartCanvas: HTMLCanvasElement | null = null;
    let startedAt = 0;
    let lastDrawAt = 0;
    let lastReportedProgress = -1;
    let drawFrameId = 0;
    let stopTimeoutId = 0;
    let fallbackStopTimeoutId = 0;
    let silentTailStartedAt: number | null = null;
    let hasHeardAudio = false;
    let hasRequestedRecorderStop = false;
    let hasScheduledRecorderStop = false;
    let onExportAudioEnded: (() => void) | null = null;
    let recorder: MediaRecorder;
    const exportAudioDelayMs = Math.round(exportAudioLookaheadSeconds * 1000);
    const stopRecorder = () => {
      hasRequestedRecorderStop = true;
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
    };
    const scheduleStopRecorder = (delayMs = 0) => {
      if (hasScheduledRecorderStop || hasRequestedRecorderStop) {
        return;
      }

      hasScheduledRecorderStop = true;
      stopTimeoutId = window.setTimeout(stopRecorder, delayMs);
    };

    const drawCompositedFrame = (
      context: CanvasRenderingContext2D,
      deltaMs = 0,
    ) => {
      exportAnalyser.getByteFrequencyData(exportLevels);
      const nextSpectrum = sampleSpectrumLevels(
        exportLevels,
        exportAnalyser.context.sampleRate,
        64,
        1000,
        16000,
      );
      const rawSpectrumPeak = nextSpectrum.reduce(
        (peak, value) => Math.max(peak, value),
        0,
      );
      const remainingAudioSeconds =
        Number.isFinite(exportAudio.duration) && exportAudio.duration > 0
          ? Math.max(0, exportAudio.duration - exportAudio.currentTime)
          : Infinity;

      if (rawSpectrumPeak >= exportTailSilencePeakThreshold) {
        hasHeardAudio = true;
        silentTailStartedAt = null;
      } else if (
        startedAt > 0 &&
        hasHeardAudio &&
        remainingAudioSeconds <= exportTailSilenceWindowSeconds
      ) {
        silentTailStartedAt ??= performance.now();

        if (
          performance.now() - silentTailStartedAt >=
          exportTailSilenceSeconds * 1000
        ) {
          scheduleStopRecorder(exportAudioDelayMs);
        }
      } else {
        silentTailStartedAt = null;
      }

      exportMeshSpectrum = exportMeshSpectrum.map((currentBand, index) =>
        currentBand * 0.68 + (nextSpectrum[index] ?? 0) * 0.32,
      );
      exportWaveformSpectrum = exportWaveformSpectrum.map((currentBand, index) => {
        const leftBand = nextSpectrum[Math.max(0, index - 1)] ?? 0;
        const centerBand = nextSpectrum[index] ?? 0;
        const rightBand = nextSpectrum[Math.min(nextSpectrum.length - 1, index + 1)] ?? 0;
        const nextBand = leftBand * 0.22 + centerBand * 0.56 + rightBand * 0.22;
        const smoothing = nextBand > currentBand ? 0.52 : 0.16;

        return currentBand + (nextBand - currentBand) * smoothing;
      });
      const nextBands = spectrumToBands(exportMeshSpectrum);
      const nextLevel = spectrumToLevel(exportMeshSpectrum);
      exportBands = exportBands.map((currentBand, index) =>
        currentBand * 0.68 + (nextBands[index] ?? 0) * 0.32,
      );
      exportLevel = exportLevel * 0.72 + nextLevel * 0.28;
      target.handle.renderExportFrame(exportBands, exportLevel, deltaMs);

      context.clearRect(0, 0, context.canvas.width, context.canvas.height);
      context.drawImage(canvas, 0, 0, context.canvas.width, context.canvas.height);

      const drewVisibleOverlay = drawVisiblePreviewOverlay(
        context,
        target.format.label,
        exportWaveformSpectrum,
        recordingOverlay,
        topLogoImage,
      );

      if (!drewVisibleOverlay) {
        drawOverlay(context, context.canvas.width, context.canvas.height, {
          audioLevel: spectrumToLevel(exportWaveformSpectrum),
          audioSpectrum: exportWaveformSpectrum,
          image: overlayImage,
          qrImage,
          topLogoImage,
          overlay: recordingOverlay,
        });
      }
    };

    if (options.isLoopable) {
      loopStartCanvas = document.createElement("canvas");
      loopStartCanvas.width = captureCanvas.width;
      loopStartCanvas.height = captureCanvas.height;

      const loopStartContext = loopStartCanvas.getContext("2d");

      if (!loopStartContext) {
        throw new Error("Video export failed.");
      }

      drawCompositedFrame(loopStartContext);
    }

    const drawFrame = () => {
      const now = performance.now();
      const elapsedMs = startedAt > 0 ? Math.min(durationMs, now - startedAt) : 0;
      const deltaMs = lastDrawAt > 0 ? now - lastDrawAt : 0;
      lastDrawAt = now;
      const nextProgress = Math.max(0, Math.min(1, elapsedMs / durationMs));

      if (
        Number.isFinite(exportAudio.duration) &&
        exportAudio.duration > 0 &&
        exportAudio.currentTime >= exportAudio.duration - 0.03
      ) {
        scheduleStopRecorder(exportAudioDelayMs);
      }

      if (nextProgress - lastReportedProgress >= 0.01 || nextProgress >= 1) {
        lastReportedProgress = nextProgress;
        onProgress(nextProgress);
      }

      drawCompositedFrame(captureContext, deltaMs);

      if (loopStartCanvas) {
        const loopFade =
          startedAt > 0 ? getLoopFadeAmount(now - startedAt, durationMs) : 0;

        if (loopFade > 0) {
          captureContext.save();
          captureContext.globalAlpha = loopFade;
          captureContext.drawImage(loopStartCanvas, 0, 0);
          captureContext.restore();
        }
      }

      drawFrameId = window.requestAnimationFrame(drawFrame);
    };

    drawCompositedFrame(captureContext);

    const videoStream = captureCanvas.captureStream(options.frameRate);
    const mixStream = new MediaStream(videoStream.getVideoTracks());
    monoDestination.stream.getAudioTracks().forEach((track: MediaStreamTrack) => {
      mixStream.addTrack(track);
    });
    const chunks: BlobPart[] = [];

    try {
      recorder = new MediaRecorder(mixStream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: exportAudioBitsPerSecond,
        videoBitsPerSecond: getCompressedVideoBitrate(target.format, options.bitratePreset),
      });
      activeExportRecorderRef.current = recorder;
    } catch (error) {
      videoStream.getTracks().forEach((track) => track.stop());
      mixStream.getTracks().forEach((track) => track.stop());
      window.cancelAnimationFrame(drawFrameId);
      throw error;
    }

    try {
      const blob = await new Promise<Blob>((resolve, reject) => {
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            chunks.push(event.data);
          }
        };
        recorder.onerror = () => {
          reject(new Error("Video export failed."));
        };
        recorder.onstop = () => {
          onProgress(1);
          resolve(
            new Blob(chunks, {
              type: recorder.mimeType || mimeType,
            }),
          );
        };

        recorder.start();
        startedAt = performance.now();
        lastDrawAt = startedAt;
        onProgress(0);
        drawFrame();
        onExportAudioEnded = () => {
          scheduleStopRecorder(exportAudioDelayMs);
        };
        exportAudio.addEventListener("ended", onExportAudioEnded, { once: true });
        void exportAudioContext.resume().catch(() => {});
        void exportAudio.play().catch(() => {
          scheduleStopRecorder(0);
        });
        fallbackStopTimeoutId = window.setTimeout(
          () => scheduleStopRecorder(0),
          durationMs + exportAudioDelayMs + 250,
        );
      });

      if (!exportCancelRef.current) {
        downloadBlob(
          blob,
          `${baseName}-${formatSlug(target.format)}-${Math.max(1, Math.round(durationMs / 1000))}s${
            options.isLoopable ? "-loop" : ""
          }.${videoFormat}`,
        );
      }
    } finally {
      if (onExportAudioEnded) {
        exportAudio.removeEventListener("ended", onExportAudioEnded);
      }
      window.clearTimeout(stopTimeoutId);
      window.clearTimeout(fallbackStopTimeoutId);
      window.cancelAnimationFrame(drawFrameId);
      exportAudio.pause();
      exportAudio.currentTime = 0;
      clearAudioMeters();
      void exportAudioContext.close();
      videoStream.getTracks().forEach((track) => track.stop());
      mixStream.getTracks().forEach((track) => track.stop());
      if (activeExportAudioRef.current === exportAudio) {
        activeExportAudioRef.current = null;
      }
      if (activeExportRecorderRef.current === recorder) {
        activeExportRecorderRef.current = null;
      }
    }
  };

  const loadVisual = (visual: VisualSnapshot) => {
    const nextMesh = normalizeMesh(visual.mesh);

    setBackgroundColor(visual.backgroundColor);
    setBlobs(cloneBlobs(visual.blobs));
    grainMixerRef.current = nextMesh.grainMixer;
    setMesh(nextMesh);
    setVisualOverlay(normalizeOverlay(visual.overlay));
    setTimelineFrame(nextMesh.frame);
    setPausedFrame(nextMesh.frame);
    setFrameOffset(0);
    setFormat(getFormatOption(visual.format.label));
    setSelectedVisualId(visual.id);
  };

  const createGallerySection = (name: string) => {
    const trimmedName = name.trim();

    if (!trimmedName) {
      return;
    }

    const section: GallerySection = {
      id: crypto.randomUUID(),
      isOpen: true,
      name: trimmedName,
    };

    setGalleryState((currentState) => ({
      ...currentState,
      sections: [...currentState.sections, section],
    }));
    setActiveGallerySectionId(section.id);
  };

  const toggleGallerySection = (sectionId: string) => {
    setGalleryState((currentState) => ({
      ...currentState,
      sections: currentState.sections.map((section) =>
        section.id === sectionId
          ? { ...section, isOpen: !section.isOpen }
          : section,
      ),
    }));
  };

  const moveVisualToSection = (visualId: string, sectionId: string) => {
    setGalleryState((currentState) => {
      const targetSectionId = getExistingSectionId(
        currentState.sections,
        sectionId,
      );
      const movedItem = currentState.items.find((item) => item.id === visualId);

      if (!movedItem) {
        return currentState;
      }

      return {
        ...currentState,
        items: [
          { ...movedItem, sectionId: targetSectionId },
          ...currentState.items.filter((item) => item.id !== visualId),
        ],
        sections: currentState.sections.map((section) =>
          section.id === targetSectionId ? { ...section, isOpen: true } : section,
        ),
      };
    });
    setActiveGallerySectionId(sectionId);
  };

  const updateAudioLevel = (
    analyser: AnalyserNode | null,
    frameRef: typeof musicFrameRef,
    updateFrame: () => void,
  ) => {
    if (!analyser) {
      setAudioBands(Array(8).fill(0));
      setAudioSpectrum(Array(64).fill(0));
      setAudioLevel(0);
      return;
    }

    const levels = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(levels);

    const nextSpectrum = sampleSpectrumLevels(
      levels,
      analyser.context.sampleRate,
      64,
      1000,
      16000,
    );
    const nextBands = Array.from({ length: 8 }, (_, bandIndex) => {
      const start = Math.floor((bandIndex / 8) * nextSpectrum.length);
      const end = Math.max(
        start + 1,
        Math.floor(((bandIndex + 1) / 8) * nextSpectrum.length),
      );
      let total = 0;

      for (let index = start; index < end; index++) {
        total += nextSpectrum[index] ?? 0;
      }

      return Math.max(0, Math.min(1, total / (end - start)));
    });
    const nextLevel = Math.max(
      0,
      Math.min(
        1,
        nextSpectrum.reduce((sum, value) => sum + value, 0) /
          Math.max(1, nextSpectrum.length),
      ),
    );

    setAudioBands((currentBands) =>
      currentBands.map((currentBand, index) =>
        currentBand * 0.68 + nextBands[index] * 0.32,
      ),
    );
    setAudioSpectrum((currentSpectrum) =>
      currentSpectrum.map((currentBand, index) =>
        currentBand * 0.5 + nextSpectrum[index] * 0.5,
      ),
    );
    setAudioLevel((currentLevel) => currentLevel * 0.72 + nextLevel * 0.28);
    frameRef.current = window.requestAnimationFrame(updateFrame);
  };

  const updateMusicLevel = () => {
    updateAudioLevel(musicAnalyserRef.current, musicFrameRef, updateMusicLevel);
  };

  const updateMicLevel = () => {
    updateAudioLevel(micAnalyserRef.current, micFrameRef, updateMicLevel);
  };

  const updateVoiceLevel = () => {
    updateAudioLevel(voiceAnalyserRef.current, voiceFrameRef, updateVoiceLevel);
  };

  const stopMusicPlayback = () => {
    musicAudioRef.current?.pause();
    window.cancelAnimationFrame(musicFrameRef.current);
    setMusicStatus("idle");
  };

  const stopMicrophone = () => {
    window.cancelAnimationFrame(micFrameRef.current);
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micSourceRef.current?.disconnect();
    micAnalyserRef.current?.disconnect();
    void micAudioContextRef.current?.close();
    micStreamRef.current = null;
    micSourceRef.current = null;
    micAnalyserRef.current = null;
    micAudioContextRef.current = null;
    setMicStatus("idle");
  };

  const stopVoicePlayback = () => {
    voiceAudioRef.current?.pause();
    window.cancelAnimationFrame(voiceFrameRef.current);
    setVoiceStatus("idle");
  };

  const toggleMusic = async () => {
    if (musicStatus === "playing") {
      stopMusicPlayback();
      setAudioBands(Array(8).fill(0));
      setAudioSpectrum(Array(64).fill(0));
      setAudioLevel(0);
      return;
    }

    stopVoicePlayback();
    stopMicrophone();
    setMusicStatus("loading");

    try {
      const audio =
        musicAudioRef.current ??
        new Audio();
      setAudioElementSource(audio, audioSource);
      audio.loop = true;
      musicAudioRef.current = audio;

      const audioContext =
        musicAudioContextRef.current ?? new AudioContext();
      musicAudioContextRef.current = audioContext;

      if (!musicSourceRef.current) {
        const source = audioContext.createMediaElementSource(audio);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.78;
        source.connect(analyser);
        connectMonoOutput(audioContext, analyser);
        musicSourceRef.current = source;
        musicAnalyserRef.current = analyser;
      }

      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }

      await audio.play();
      setMusicStatus("playing");
      updateMusicLevel();
    } catch {
      setMusicStatus("idle");
      setAudioBands(Array(8).fill(0));
      setAudioSpectrum(Array(64).fill(0));
      setAudioLevel(0);
      setVoiceNotice("Music playback failed. Try clicking the music button again.");
    }
  };

  const toggleMicrophone = async () => {
    if (micStatus === "listening") {
      stopMicrophone();
      setAudioBands(Array(8).fill(0));
      setAudioSpectrum(Array(64).fill(0));
      setAudioLevel(0);
      setVoiceNotice("");
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setVoiceNotice("Microphone input is not supported in this browser.");
      return;
    }

    stopMusicPlayback();
    stopVoicePlayback();
    setMicStatus("loading");
    setVoiceNotice("");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      stream.getAudioTracks().forEach((track) => {
        track.onended = () => {
          stopMicrophone();
          setAudioBands(Array(8).fill(0));
          setAudioSpectrum(Array(64).fill(0));
          setAudioLevel(0);
        };
      });
      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.82;
      source.connect(analyser);

      micStreamRef.current = stream;
      micAudioContextRef.current = audioContext;
      micSourceRef.current = source;
      micAnalyserRef.current = analyser;

      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }

      setMicStatus("listening");
      updateMicLevel();
    } catch (error) {
      stopMicrophone();
      setAudioBands(Array(8).fill(0));
      setAudioSpectrum(Array(64).fill(0));
      setAudioLevel(0);
      setVoiceNotice(
        error instanceof Error && error.name === "NotAllowedError"
          ? "Microphone permission was denied."
          : "Microphone input failed. Check browser permission and try again.",
      );
    }
  };

  const playVoiceLine = async () => {
    if (voiceStatus !== "idle") {
      stopVoicePlayback();
      setAudioBands(Array(8).fill(0));
      setAudioSpectrum(Array(64).fill(0));
      setAudioLevel(0);
      setVoiceNotice("");
      return;
    }

    stopMusicPlayback();
    stopMicrophone();
    setVoiceStatus("loading");
    setVoiceNotice("");

    try {
      const audio =
        voiceAudioRef.current ??
        new Audio();
      setAudioElementSource(audio, audioSource);
      audio.loop = false;
      audio.currentTime = 0;
      voiceAudioRef.current = audio;

      const audioContext =
        voiceAudioContextRef.current ?? new AudioContext();
      voiceAudioContextRef.current = audioContext;

      if (!voiceSourceRef.current) {
        const source = audioContext.createMediaElementSource(audio);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.78;
        source.connect(analyser);
        connectMonoOutput(audioContext, analyser);
        voiceSourceRef.current = source;
        voiceAnalyserRef.current = analyser;
      }

      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }

      audio.onended = () => {
        window.cancelAnimationFrame(voiceFrameRef.current);
        setVoiceStatus("idle");
        setAudioBands(Array(8).fill(0));
        setAudioSpectrum(Array(64).fill(0));
        setAudioLevel(0);
      };
      audio.onerror = () => {
        window.cancelAnimationFrame(voiceFrameRef.current);
        setVoiceStatus("idle");
        setAudioBands(Array(8).fill(0));
        setAudioSpectrum(Array(64).fill(0));
        setAudioLevel(0);
        setVoiceNotice("MP3 playback failed. Try clicking the audio button again.");
      };

      await audio.play();
      setVoiceStatus("playing");
      updateVoiceLevel();
    } catch (error) {
      setVoiceStatus("idle");
      setAudioBands(Array(8).fill(0));
      setAudioSpectrum(Array(64).fill(0));
      setAudioLevel(0);
      setVoiceNotice(
        error instanceof Error && error.message
          ? `MP3 playback failed: ${error.message}`
          : "MP3 playback failed. Try clicking the audio button again.",
      );
    }
  };

  return (
    <main className="app-shell" data-theme={uiTheme}>
      <header className="app-header">
        <div className="app-brand">
          <img
            alt="Outcraft"
            className="app-brand-logo"
            src={
              getOverlayDataUrl({
                ...visualOverlay,
                asset: "logo",
                tone: uiTheme === "dark" ? "light" : "dark",
              }) ?? undefined
            }
          />
          <span className="app-brand-divider" aria-hidden="true" />
          <span className="app-brand-title">Voice AI Visualizer</span>
        </div>
        <ThemeToggle value={uiTheme} onChange={setUiTheme} />
      </header>

      <section
        className="control-panel relative z-10 flex flex-col gap-5 overflow-y-auto p-8"
        aria-label="Mesh controls"
      >
        <Tabs value={activeTab} onChange={setActiveTab} />

        {activeTab === "generate" ? (
          <>
            <div className="grid gap-2.5">
              <span className="text-xs font-bold uppercase text-[var(--muted-foreground)]">
                Format &amp; Export
              </span>
              <div className="format-toggle-grid">
                {singleFormatOptions.map((option) => (
                  <button
                    aria-pressed={exportFormats.has(option.label)}
                    key={option.label}
                    className={cn(
                      "format-toggle",
                      exportFormats.has(option.label) && "format-toggle-active",
                      format.label === option.label && "format-toggle-current",
                    )}
                    type="button"
                    onClick={() => toggleExportFormat(option)}
                  >
                    <span className="format-toggle-copy">
                      <span className="format-toggle-label">
                        {option.label}
                      </span>
                      <span className="format-toggle-size">
                        {option.name}
                      </span>
                    </span>
                    <span className="format-toggle-switch" aria-hidden="true">
                      <span />
                    </span>
                  </button>
                ))}
              </div>
              <div className="grid gap-2">
                <Button
                  className="w-full"
                  disabled={isExportingVideo || exportFormats.size === 0}
                  type="button"
                  variant="default"
                  onClick={() => exportPng(2)}
                >
                  {exportFormats.size > 1
                    ? `Export PNG 2x (${exportFormats.size} formats)`
                    : "Export PNG 2x"}
                </Button>
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                  <Button
                    className="w-full"
                    disabled={isExportingVideo || exportFormats.size === 0}
                    type="button"
                    variant="secondary"
                    onClick={() => exportVideo(videoExportFormat)}
                  >
                    {isExportingVideo
                      ? "Recording..."
                      : exportFormats.size > 1
                        ? `Export Video (${exportFormats.size} formats)`
                        : "Export Video"}
                  </Button>
                  <ExportVideoSettings
                    bitratePreset={videoBitratePreset}
                    disabled={isExportingVideo}
                    frameRate={videoFrameRate}
                    videoFormat={videoExportFormat}
                    onBitratePresetChange={setVideoBitratePreset}
                    onFrameRateChange={setVideoFrameRate}
                    onVideoFormatChange={setVideoExportFormat}
                  />
                </div>
              </div>
            </div>

            <label className="grid gap-2">
              <span className="text-xs font-bold uppercase text-[var(--muted-foreground)]">
                Audio File
              </span>
              <span className="audio-file-input">
                <input
                  accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg"
                  type="file"
                  onChange={handleAudioFileChange}
                />
                <span className="audio-file-button">Choose File</span>
                <span className="audio-file-name">
                  {audioFileName === "Default MP3" ? "No file chosen" : audioFileName}
                </span>
              </span>
            </label>

            <section className="timeline-panel grid gap-3 border-t border-[var(--border)] pt-5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-bold uppercase text-[var(--muted-foreground)]">
                  Timeline
                </span>
                <Button
                  aria-label={isPaused ? "Play visual timeline" : "Pause visual timeline"}
                  disabled={isExportingVideo}
                  size="icon"
                  type="button"
                  variant={isPaused ? "secondary" : "outline"}
                  onClick={togglePlayback}
                >
                  {isPaused ? (
                    <Play className="size-4" aria-hidden="true" />
                  ) : (
                    <Pause className="size-4" aria-hidden="true" />
                  )}
                </Button>
              </div>
              <label className={cn("grid gap-2.5", isExportingVideo && "opacity-55")}>
                <span className="flex items-center justify-between gap-4 text-sm font-semibold text-[var(--muted-foreground)]">
                  <span>Frame</span>
                  <strong className="text-xs text-[var(--primary)]">
                    {formatTimelineFrame(timelineFrame)}
                  </strong>
                </span>
                <Slider
                  aria-label="Timeline"
                  className="timeline-slider"
                  data-frame-offset={Math.round(frameOffset)}
                  data-frame-scrubber
                  disabled={isExportingVideo}
                  max={meshFrameMax}
                  min={0}
                  step={1}
                  value={[timelineFrame]}
                  onValueChange={([nextValue]) => scrubTimelineFrame(nextValue)}
                />
              </label>
            </section>

            <div className="grid grid-cols-6 gap-2.5">
              <Button
                aria-label="Randomize composition"
                type="button"
                variant="outline"
                size="icon"
                onClick={randomizeComposition}
              >
                <Shuffle className="size-4" aria-hidden="true" />
              </Button>
              <Button
                aria-label="Randomize colors"
                type="button"
                variant="outline"
                size="icon"
                onClick={randomizeColors}
              >
                <Palette className="size-4" aria-hidden="true" />
              </Button>
              <Button
                aria-label="Save to gallery"
                type="button"
                variant="outline"
                size="icon"
                onClick={saveCurrentVisual}
              >
                <Heart className="size-4" aria-hidden="true" />
              </Button>
              <Button
                aria-label={musicStatus === "playing" ? "Pause sample audio" : "Play sample audio"}
                disabled={musicStatus === "loading"}
                size="icon"
                type="button"
                variant={musicStatus === "playing" ? "secondary" : "outline"}
                onClick={toggleMusic}
              >
                <AudioLines className="size-4" aria-hidden="true" />
              </Button>
              <Button
                aria-label={micStatus === "listening" ? "Stop microphone input" : "Start microphone input"}
                disabled={micStatus === "loading"}
                size="icon"
                type="button"
                variant={micStatus === "listening" ? "secondary" : "outline"}
                onClick={toggleMicrophone}
              >
                <Mic className="size-4" aria-hidden="true" />
              </Button>
              <Button
                aria-label={voiceStatus === "playing" ? "Pause MP3 audio" : "Play MP3 audio"}
                disabled={voiceStatus === "loading"}
                size="icon"
                type="button"
                variant={voiceStatus === "playing" ? "secondary" : "outline"}
                onClick={playVoiceLine}
              >
                <Volume2 className="size-4" aria-hidden="true" />
              </Button>
            </div>
            {voiceNotice ? (
              <p className="-mt-3 rounded-md border border-[var(--border)] bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-[var(--muted-foreground)]">
                {voiceNotice}
              </p>
            ) : null}

            <OverlaySettings
              overlay={visualOverlay}
              onChange={setVisualOverlay}
            />

            <SwatchField
              activePaletteId={activePaletteId}
              label="Background"
              value={backgroundColor}
              onPaletteChange={setActivePaletteId}
              onChange={setBackgroundColor}
            />

            <section className="grid gap-4 border-t border-[var(--border)] pt-5">
              <h2 className="text-base font-bold text-[var(--foreground)]">Mesh</h2>

              <RangeControl
                label="Speed"
                max={1.8}
                min={0}
                step={0.01}
                value={mesh.speed}
                onChange={(value) => updateMesh("speed", value)}
              />
              <RangeControl
                label="Scale"
                max={5}
                min={0.55}
                step={0.01}
                value={mesh.scale}
                onChange={(value) => updateMesh("scale", value)}
              />
              <RangeControl
                label="Distortion"
                max={1.2}
                min={0}
                step={0.01}
                value={mesh.distortion}
                onChange={(value) => updateMesh("distortion", value)}
              />
              <RangeControl
                label="Idle Warp"
                max={5}
                min={0}
                step={0.01}
                value={mesh.idleWarp}
                onChange={(value) => updateMesh("idleWarp", value)}
              />
              <RangeControl
                label="Audio Reactivity"
                max={50}
                min={0}
                step={0.5}
                value={mesh.audioReactivity ?? initialMesh.audioReactivity}
                onChange={(value) => updateMesh("audioReactivity", value)}
              />
              <RangeControl
                label="Audio Smoothness"
                max={20}
                min={0}
                step={0.5}
                value={mesh.audioSmoothness ?? initialMesh.audioSmoothness}
                onChange={(value) => updateMesh("audioSmoothness", value)}
              />
              <RangeControl
                label="Swirl"
                max={0.6}
                min={0}
                step={0.01}
                value={mesh.swirl}
                onChange={(value) => updateMesh("swirl", value)}
              />
              <RangeControl
                label="Blur"
                max={1}
                min={0}
                step={0.01}
                value={mesh.motionBlur}
                onChange={(value) => updateMesh("motionBlur", value)}
              />
              <RangeControl
                label="Grain"
                max={0.2}
                min={0}
                step={0.001}
                value={mesh.grainMixer}
                onChange={(value) => updateMesh("grainMixer", value)}
              />
            </section>

            <div className="grid gap-5">
              {blobs.map((blob) => (
                <section
                  className="grid gap-4 border-t border-[var(--border)] pt-5"
                  key={blob.id}
                >
                  <div className="flex items-center justify-between gap-4">
                    <h2 className="text-base font-bold text-[var(--foreground)]">
                      {blob.name}
                    </h2>
                    <span
                      className="size-6 rounded-full border border-[var(--border)]"
                      style={{ background: blob.color }}
                    />
                  </div>

                  <SwatchField
                    activePaletteId={activePaletteId}
                    label="Color"
                    value={blob.color}
                    onPaletteChange={setActivePaletteId}
                    onChange={(value) => updateBlob(blob.id, "color", value)}
                  />

                  <RangeControl
                    label="Opacity"
                    max={1}
                    min={0}
                    step={0.01}
                    value={blob.opacity}
                    onChange={(value) => updateBlob(blob.id, "opacity", value)}
                  />
                  <RangeControl
                    label="X"
                    max={1}
                    min={0}
                    step={0.01}
                    value={blob.x}
                    onChange={(value) => updateBlob(blob.id, "x", value)}
                  />
                  <RangeControl
                    label="Y"
                    max={1}
                    min={0}
                    step={0.01}
                    value={blob.y}
                    onChange={(value) => updateBlob(blob.id, "y", value)}
                  />
                  <RangeControl
                    label="Size"
                    max={2}
                    min={0.08}
                    step={0.01}
                    value={blob.size}
                    onChange={(value) => updateBlob(blob.id, "size", value)}
                  />
                  <RangeControl
                    label="Ellipse"
                    max={2.8}
                    min={0.35}
                    step={0.01}
                    value={blob.stretch}
                    onChange={(value) => updateBlob(blob.id, "stretch", value)}
                  />
                  <RangeControl
                    label="Bend"
                    max={1.2}
                    min={-1.2}
                    step={0.01}
                    value={blob.bend}
                    onChange={(value) => updateBlob(blob.id, "bend", value)}
                  />
                  <RangeControl
                    label="Taper"
                    max={0.95}
                    min={-0.95}
                    step={0.01}
                    value={blob.taper}
                    onChange={(value) => updateBlob(blob.id, "taper", value)}
                  />
                </section>
              ))}
            </div>
          </>
        ) : (
          <Gallery
            items={gallery}
            saveStatus={gallerySaveStatus}
            sections={gallerySections}
            selectedVisualId={selectedVisualId}
            onCreateSection={createGallerySection}
            onMoveVisual={moveVisualToSection}
            onSelect={loadVisual}
            onToggleSection={toggleGallerySection}
          />
        )}
      </section>

      <section
        className={cn(
          "preview-area",
          isPreviewDragging && "preview-area-dragging",
          isExportingVideo && "preview-area-recording",
        )}
        aria-label="Visual preview"
        onPointerCancel={stopPreviewDrag}
        onPointerDown={startPreviewDrag}
        onPointerMove={movePreviewDrag}
        onPointerUp={stopPreviewDrag}
      >
        <div className="preview-artboard" style={previewArtboardStyle}>
          <div className="format-overview" data-format-count={visiblePreviewFormats.length}>
            {visiblePreviewFormats.map((previewFormat) => {
              const formatProgress =
                videoExportProgress?.formatLabel === previewFormat.label
                  ? videoExportProgress.progress
                  : 0;
              const isRecordingFormat =
                isExportingVideo && videoExportProgress?.formatLabel === previewFormat.label;

              return (
                <div className="format-overview-item" key={previewFormat.label}>
                  <span>{previewFormat.label}</span>
                  <div
                    data-format-label={previewFormat.label}
                    className={cn(
                      "format-frame",
                      getPreviewFrameClass(previewFormat.label),
                    )}
                    style={
                      {
                        ...frameAudioStyle,
                        "--format-ratio": `${previewFormat.width / previewFormat.height}`,
                        aspectRatio: `${previewFormat.width} / ${previewFormat.height}`,
                      } as CSSProperties
                    }
                  >
                    <ShaderStage
                      audioBands={audioBands}
                      audioLevel={audioLevel}
                      ref={(handle) => {
                        formatStageRefs.current[previewFormat.label] = handle;

                        if (previewFormat.label === primaryPreviewFormat.label) {
                          stageRef.current = handle;
                        }
                      }}
                      backgroundColor={backgroundColor}
                      blobs={blobs}
                      isPaused={isPaused || isExportingVideo}
                      mesh={mesh}
                    />
                    <VisualOverlayMark
                      audioSpectrum={audioSpectrum}
                      audioLevel={audioLevel}
                      frameShape={frameShape}
                      overlay={visualOverlay}
                    />
                    <SceneDecorations overlay={visualOverlay} />
                  </div>
                  <div
                    aria-hidden={!isRecordingFormat}
                    aria-label={
                      isRecordingFormat
                        ? `${previewFormat.label} exporting ${Math.round(formatProgress * 100)}%`
                        : undefined
                    }
                    className={cn(
                      "format-export-progress",
                      !isRecordingFormat && "format-export-progress-hidden",
                    )}
                    style={{ "--format-progress": formatProgress.toFixed(4) } as CSSProperties}
                  >
                    <span className="format-export-progress-track">
                      <span className="format-export-progress-fill" />
                    </span>
                    <span className="format-export-progress-label">
                      {Math.round(formatProgress * 100)}%
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="artboard-zoom-controls" aria-label="Preview zoom controls">
          <Button
            aria-label="Zoom in preview"
            disabled={previewZoom >= 2.5}
            size="icon"
            type="button"
            variant="outline"
            onClick={() => updatePreviewZoom(0.1)}
          >
            <Plus className="size-4" aria-hidden="true" />
          </Button>
          <Button
            aria-label="Zoom out preview"
            disabled={previewZoom <= 0.45}
            size="icon"
            type="button"
            variant="outline"
            onClick={() => updatePreviewZoom(-0.1)}
          >
            <Minus className="size-4" aria-hidden="true" />
          </Button>
        </div>
        {isExportingVideo ? (
          <div
            aria-label={`Exporting ${recordingProgressPercent}%`}
            aria-live="polite"
            className="recording-cover"
            role="status"
            style={recordingProgressStyle}
          >
            <div className="recording-progress-ring">
              <span>{recordingProgressPercent}%</span>
            </div>
            <span className="recording-progress-text">
              Exporting {videoExportProgress?.formatLabel ?? ""}
              <span className="recording-ellipsis" aria-hidden="true">
                <span>.</span>
                <span>.</span>
                <span>.</span>
              </span>
            </span>
            <Button
              className="recording-cancel-button"
              type="button"
              variant="outline"
              onClick={cancelVideoExport}
            >
              Cancel
            </Button>
          </div>
        ) : null}
      </section>
    </main>
  );
}

type RangeControlProps = {
  disabled?: boolean;
  formatValue?: (value: number, step: number) => string;
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  step: number;
  value: number;
};

function RangeControl({
  disabled = false,
  formatValue = formatRangeValue,
  label,
  max,
  min,
  onChange,
  step,
  value,
}: RangeControlProps) {
  return (
    <label
      className={cn("grid gap-2.5", disabled && "opacity-55")}
      data-range-control={label}
    >
      <span className="flex items-center justify-between gap-4 text-sm font-semibold text-[var(--muted-foreground)]">
        <span>{label}</span>
        <strong className="text-xs text-[var(--primary)]">
          {formatValue(value, step)}
        </strong>
      </span>
      <Slider
        aria-label={label}
        disabled={disabled}
        max={max}
        min={min}
        step={step}
        value={[value]}
        onValueChange={([nextValue]) => onChange(nextValue)}
      />
    </label>
  );
}

function formatRangeValue(value: number, step: number) {
  if (step >= 1) {
    return Math.round(value).toString();
  }

  return value.toFixed(step < 0.01 ? 3 : 2);
}

function formatTimelineFrame(value: number) {
  return Math.round(value).toLocaleString("en-US");
}

type ExportVideoSettingsProps = {
  bitratePreset: VideoBitratePreset;
  disabled: boolean;
  frameRate: VideoFrameRate;
  onBitratePresetChange: (preset: VideoBitratePreset) => void;
  onFrameRateChange: (frameRate: VideoFrameRate) => void;
  onVideoFormatChange: (format: VideoExportFormat) => void;
  videoFormat: VideoExportFormat;
};

function ExportVideoSettings({
  bitratePreset,
  disabled,
  frameRate,
  onBitratePresetChange,
  onFrameRateChange,
  onVideoFormatChange,
  videoFormat,
}: ExportVideoSettingsProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const closeOnPointerDown = (event: globalThis.PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);

    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isOpen]);

  return (
    <div className="relative" ref={menuRef}>
      <Button
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-label="Video export settings"
        disabled={disabled}
        size="icon"
        type="button"
        variant="outline"
        onClick={() => setIsOpen((currentValue) => !currentValue)}
      >
        <SlidersHorizontal className="size-4" aria-hidden="true" />
      </Button>
      {isOpen ? (
        <div
          className="absolute right-0 top-[calc(100%+6px)] z-30 min-w-52 rounded-md border border-[var(--border)] bg-[var(--popover)] p-1 text-[var(--popover-foreground)] shadow-lg"
          role="menu"
        >
          <div className="px-3 py-1.5 text-xs font-bold uppercase text-[var(--muted-foreground)]">
            Format
          </div>
          {(["mp4", "webm"] as const).map((formatOption) => (
            <MenuCheckItem
              isSelected={videoFormat === formatOption}
              key={formatOption}
              label={formatOption.toUpperCase()}
              onClick={() => onVideoFormatChange(formatOption)}
            />
          ))}
          <div className="my-1 h-px bg-[var(--border)]" role="separator" />
          <div className="px-3 py-1.5 text-xs font-bold uppercase text-[var(--muted-foreground)]">
            FPS
          </div>
          {([30, 60] as const).map((frameRateOption) => (
            <MenuCheckItem
              isSelected={frameRate === frameRateOption}
              key={frameRateOption}
              label={`${frameRateOption} fps`}
              onClick={() => onFrameRateChange(frameRateOption)}
            />
          ))}
          <div className="my-1 h-px bg-[var(--border)]" role="separator" />
          <div className="px-3 py-1.5 text-xs font-bold uppercase text-[var(--muted-foreground)]">
            Bitrate
          </div>
          {[
            { label: "Low", value: "low" },
            { label: "Standard", value: "standard" },
            { label: "High", value: "high" },
          ].map((option) => (
            <MenuCheckItem
              isSelected={bitratePreset === option.value}
              key={option.value}
              label={option.label}
              onClick={() => onBitratePresetChange(option.value as VideoBitratePreset)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

type MenuCheckItemProps = {
  isSelected: boolean;
  label: string;
  onClick: () => void;
};

function MenuCheckItem({ isSelected, label, onClick }: MenuCheckItemProps) {
  return (
    <button
      aria-checked={isSelected}
      className="flex min-h-9 w-full items-center justify-between gap-3 rounded px-3 text-left text-sm font-semibold transition hover:bg-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      onClick={onClick}
      role="menuitemcheckbox"
      type="button"
    >
      <span>{label}</span>
      {isSelected ? <Check className="size-4" aria-hidden="true" /> : null}
    </button>
  );
}

function getAudioBandColor(audioBands: number[], blobs: BlobConfig[]) {
  if (blobs.length === 0) {
    return "#18c5d4";
  }

  let loudestBandIndex = 0;
  let loudestBandValue = -1;

  audioBands.forEach((bandValue, index) => {
    if (bandValue > loudestBandValue) {
      loudestBandIndex = index;
      loudestBandValue = bandValue;
    }
  });

  return blobs[loudestBandIndex % blobs.length]?.color ?? blobs[0].color;
}

function spectrumToBands(spectrum: number[]) {
  return Array.from({ length: 8 }, (_, bandIndex) => {
    const start = Math.floor((bandIndex / 8) * spectrum.length);
    const end = Math.max(
      start + 1,
      Math.floor(((bandIndex + 1) / 8) * spectrum.length),
    );
    let total = 0;

    for (let index = start; index < end; index++) {
      total += spectrum[index] ?? 0;
    }

    return Math.max(0, Math.min(1, total / (end - start)));
  });
}

function spectrumToLevel(spectrum: number[]) {
  return Math.max(
    0,
    Math.min(
      1,
      spectrum.reduce((sum, value) => sum + value, 0) /
        Math.max(1, spectrum.length),
    ),
  );
}

type ExportControlProps = {
  isExportingAllFormats: boolean;
  isExportingVideo: boolean;
  isVideoLoopEnabled: boolean;
  onExportPng: (scale: 1 | 2) => void;
  onExportVideo: (format: VideoExportFormat) => void;
  onToggleVideoLoop: () => void;
  onVideoDurationChange: (duration: VideoDuration) => void;
  videoDuration: VideoDuration;
};

function ExportControl({
  isExportingAllFormats,
  isExportingVideo,
  isVideoLoopEnabled,
  onExportPng,
  onExportVideo,
  onToggleVideoLoop,
  onVideoDurationChange,
  videoDuration,
}: ExportControlProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const targetLabel = isExportingAllFormats ? "all formats" : "current format";

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const closeOnPointerDown = (event: globalThis.PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);

    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isOpen]);

  const runExport = (callback: () => void) => {
    callback();
    setIsOpen(false);
  };

  return (
    <div className="relative min-w-0" ref={menuRef}>
      <Button
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-label={`Export ${targetLabel}`}
        className="w-full min-w-0 px-3"
        disabled={isExportingVideo}
        type="button"
        variant="secondary"
        onClick={() => setIsOpen((currentValue) => !currentValue)}
      >
        {isExportingVideo ? `Recording ${videoDuration}s` : "Export"}
      </Button>
      {isOpen ? (
        <div
          className="absolute right-0 top-[calc(100%+6px)] z-20 min-w-44 rounded-md border border-[var(--border)] bg-[var(--popover)] p-1 text-[var(--popover-foreground)] shadow-lg"
          role="menu"
        >
          <div className="px-3 py-1.5 text-xs font-bold uppercase text-[var(--muted-foreground)]">
            Image
          </div>
          <button
            className="flex min-h-9 w-full items-center rounded px-3 text-left text-sm font-semibold transition hover:bg-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            onClick={() => runExport(() => onExportPng(1))}
            role="menuitem"
            type="button"
          >
            PNG 1x
          </button>
          <button
            className="flex min-h-9 w-full items-center rounded px-3 text-left text-sm font-semibold transition hover:bg-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            onClick={() => runExport(() => onExportPng(2))}
            role="menuitem"
            type="button"
          >
            PNG 2x
          </button>
          <div className="my-1 h-px bg-[var(--border)]" role="separator" />
          <div className="px-3 py-1.5 text-xs font-bold uppercase text-[var(--muted-foreground)]">
            Video
          </div>
          <button
            className="flex min-h-9 w-full items-center rounded px-3 text-left text-sm font-semibold transition hover:bg-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            onClick={() => runExport(() => onExportVideo("webm"))}
            role="menuitem"
            type="button"
          >
            WEBM
          </button>
          <button
            className="flex min-h-9 w-full items-center rounded px-3 text-left text-sm font-semibold transition hover:bg-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            onClick={() => runExport(() => onExportVideo("mp4"))}
            role="menuitem"
            type="button"
          >
            MP4
          </button>
          <div className="my-1 h-px bg-[var(--border)]" role="separator" />
          <div className="px-3 py-1.5 text-xs font-bold uppercase text-[var(--muted-foreground)]">
            Video duration
          </div>
          {videoDurationOptions.map((duration) => (
            <button
              aria-checked={videoDuration === duration}
              className="flex min-h-9 w-full items-center justify-between gap-3 rounded px-3 text-left text-sm font-semibold transition hover:bg-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              key={duration}
              onClick={() => onVideoDurationChange(duration)}
              role="menuitemcheckbox"
              type="button"
            >
              <span>{duration} seconds</span>
              {videoDuration === duration ? (
                <Check className="size-4" aria-hidden="true" />
              ) : null}
            </button>
          ))}
          <div className="my-1 h-px bg-[var(--border)]" role="separator" />
          <button
            aria-checked={isVideoLoopEnabled}
            className="flex min-h-9 w-full items-center justify-between gap-3 rounded px-3 text-left text-sm font-semibold transition hover:bg-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            onClick={onToggleVideoLoop}
            role="menuitemcheckbox"
            type="button"
          >
            <span>Loopable video</span>
            {isVideoLoopEnabled ? (
              <Check className="size-4" aria-hidden="true" />
            ) : null}
          </button>
        </div>
      ) : null}
    </div>
  );
}

type OverlayControlProps = {
  onChange: (overlay: VisualOverlay) => void;
  overlay: VisualOverlay;
};

function OverlaySettings({ onChange, overlay }: OverlayControlProps) {
  const updateOverlay = (nextOverlay: Partial<VisualOverlay>) => {
    onChange({ ...overlay, ...nextOverlay });
  };

  return (
    <section className="grid gap-3 border-t border-[var(--border)] pt-5">
      <h2 className="text-base font-bold text-[var(--foreground)]">Overlay</h2>
      <SelectField
        label="Right bottom"
        value={overlay.bottomRight}
        onChange={(value) =>
          updateOverlay({ bottomRight: value as BottomRightOverlay, showBottomCta: true })
        }
      >
        <option value="button">Book a Demo</option>
        <option value="qr">QR Code</option>
        <option value="slogan">Slogan right</option>
      </SelectField>
      <SelectField
        label="Left bottom slogan"
        value={overlay.showBottomLeftSlogan ? "show" : "hide"}
        onChange={(value) =>
          updateOverlay({
            showBottomLeftSlogan: value === "show",
          })
        }
      >
        <option value="show">Show</option>
        <option value="hide">Hide</option>
      </SelectField>
      <SelectField
        label="Top left logo"
        value={overlay.showTopLogo ? "show" : "hide"}
        onChange={(value) => updateOverlay({ showTopLogo: value === "show" })}
      >
        <option value="show">Show</option>
        <option value="hide">Hide</option>
      </SelectField>
      <SelectField
        label="Tone"
        value={overlay.tone}
        onChange={(value) => updateOverlay({ tone: value as OverlayTone })}
      >
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </SelectField>
    </section>
  );
}

type SelectFieldProps = {
  children: ReactNode;
  label: string;
  onChange: (value: string) => void;
  value: string;
};

function SelectField({ children, label, onChange, value }: SelectFieldProps) {
  return (
    <label className="grid gap-2">
      <span className="text-xs font-bold uppercase text-[var(--muted-foreground)]">
        {label}
      </span>
      <select
        className="min-h-10 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-semibold text-[var(--foreground)] outline-none transition focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {children}
      </select>
    </label>
  );
}

function SceneSlogan({
  align = "left",
  className,
}: {
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "scene-bottom-slogan scene-bottom-text pointer-events-none absolute z-20 select-none font-medium leading-none",
        align === "right" && "scene-bottom-text-right",
        className,
      )}
      data-align={align}
      style={{ fontFamily: "'Bricolage Grotesque', sans-serif" }}
    >
      <span className="scene-slogan-word">Autonomous</span>{" "}
      <span className="scene-slogan-word">Revenue</span>{" "}
      <span className="scene-slogan-word">Engine</span>
    </span>
  );
}

function SceneQrCode({
  tone,
}: {
  tone: OverlayTone;
}) {
  return (
    <img
      alt=""
      aria-hidden="true"
      className="scene-qr-code pointer-events-none absolute z-20 select-none"
      src={getQrCodeDataUrl(tone)}
    />
  );
}

function VisualOverlayMark({
  audioSpectrum,
  audioLevel,
  frameShape,
  overlay,
}: {
  audioSpectrum: number[];
  audioLevel: number;
  frameShape: FrameShape;
  overlay: VisualOverlay;
}) {
  if (overlay.asset === "waveform") {
    return (
      <SoundWaveOverlay
        audioSpectrum={audioSpectrum}
        audioLevel={audioLevel}
        tone={overlay.tone}
      />
    );
  }

  const overlaySource = getOverlayDataUrl(overlay);

  if (!overlaySource) {
    return null;
  }

  const overlayStyle = {
    "--overlay-audio-level": audioLevel.toFixed(3),
  } as CSSProperties;

  // Padidinam star overlay 1.5 karto TIK circle formate
  const extraScale = overlay.asset === "star" && frameShape === "circle" ? 1.5 : 1;
  return (
    <span
      className={cn(
        "visual-overlay pointer-events-none absolute left-1/2 top-1/2 z-10 select-none",
        `visual-overlay-${frameShape}`,
        overlay.asset === "star"
          ? "visual-overlay-star w-[35%] min-w-16 max-w-48"
          : "visual-overlay-logo w-[62%] max-w-[320px]",
      )}
      style={{
        ...overlayStyle,
        transform: `translate(-50%, -50%) scale(${extraScale})`,
      }}
    >
      {overlay.asset === "star" ? (
        <img
          alt=""
          aria-hidden="true"
          className="visual-overlay-glow"
          src={overlaySource}
        />
      ) : null}
      <img className="visual-overlay-mark" alt="" src={overlaySource} />
    </span>
  );
}

function SoundWaveOverlay({
  audioSpectrum,
  audioLevel,
  tone,
}: {
  audioSpectrum: number[];
  audioLevel: number;
  tone: OverlayTone;
}) {
  void audioLevel;
  const style = getWaveformStyle();
  const noiseFloor = style.noiseFloor;
  const totalBars = 64;
  const halfBars = totalBars / 2;
  const centerEnvelopePower = style.centerEnvelopePower;
  const sideFloor = style.sideFloor;
  const sideMotionMix = style.sideMotionMix;
  const widthFactor = style.widthFactor;
  const centerGain = style.centerGain;
  const edgeGain = style.edgeGain;
  if (style.useStarProfile) {
    const frameMax = audioSpectrum.reduce(
      (m, b) => Math.max(m, Math.max(0, (b - noiseFloor) / (1 - noiseFloor))),
      0.001,
    );
    _starNormalizedPeak = Math.max(_starNormalizedPeak * 0.9997, frameMax);
  }

  const bars = Array.from({ length: totalBars }, (_, index) => {
    const mirroredIndex = index < halfBars ? halfBars - 1 - index : index - halfBars;
    const centeredProgress = mirroredIndex / Math.max(halfBars - 1, 1);
    const compressedProgress = 0.5 + (centeredProgress - 0.5) * widthFactor;
    const sourceProgress = Math.max(0, Math.min(1, compressedProgress));
    const sourceIndex = Math.floor(sourceProgress * (audioSpectrum.length - 1));
    const band = audioSpectrum[sourceIndex] ?? 0;
    const normalizedBand = Math.max(0, (band - noiseFloor) / (1 - noiseFloor));
    const centerDistance =
      Math.abs(index - (totalBars - 1) / 2) / ((totalBars - 1) / 2);
    const centerEnvelope =
      sideFloor + (1 - centerDistance) ** centerEnvelopePower * (1 - sideFloor);
    const gainWeight = (1 - centerDistance) ** centerEnvelopePower;
    const gain = edgeGain + (centerGain - edgeGain) * gainWeight;
    const shapedBand =
      normalizedBand * sideMotionMix + normalizedBand * centerEnvelope * (1 - sideMotionMix);
    const effectiveBand = Math.max(0, Math.min(1, shapedBand * gain));
    const bell = 1 + style.bellBoost * (1 - centerDistance) ** 6;
    const height = style.useStarProfile
      ? (normalizedBand / _starNormalizedPeak) * (STAR_BAR_PROFILE[mirroredIndex] ?? 1) * 100
      : Math.max(0, Math.min(1, effectiveBand)) * 100 * bell;
    const opacity = getWaveformBarOpacity(mirroredIndex);
    return {
      height: Math.max(0, height),
      opacity,
    };
  });

  return (
    <span
      className={cn(
        "sound-wave-overlay pointer-events-none absolute left-1/2 top-1/2 z-10 select-none",
        tone === "dark" && "sound-wave-overlay-dark",
      )}
    >
      <span className="sound-wave-overlay-track">
        {bars.map((bar, index) => (
          <span
            aria-hidden="true"
            className="sound-wave-overlay-bar"
            key={index}
            style={{ height: `${bar.height}%`, opacity: bar.opacity }}
          />
        ))}
      </span>
    </span>
  );
}

function SceneDecorations({
  overlay,
}: {
  overlay: VisualOverlay;
}) {
  const isLight = overlay.tone !== "dark";
  const textColor = isLight ? "text-white" : "text-[#01151e]";
  const hasRightContent = overlay.showBottomCta;

  return (
    <>
      {overlay.showTopLogo ? (
        <img
          className="scene-logo pointer-events-none absolute z-20 w-auto select-none"
          alt=""
          aria-hidden="true"
          src={getOverlayDataUrl({ ...overlay, asset: "logo" }) ?? undefined}
        />
      ) : null}
      {overlay.showBottomLeftSlogan ? (
        <SceneSlogan className={textColor} />
      ) : null}
      {hasRightContent ? (
        overlay.bottomRight === "qr" ? (
          <SceneQrCode tone={overlay.tone} />
        ) : overlay.bottomRight === "slogan" ? (
          <SceneSlogan align="right" className={textColor} />
        ) : (
          <span
            className={cn(
              "scene-demo-button pointer-events-none absolute z-20 inline-flex select-none items-center justify-center rounded-full font-medium",
              isLight ? "scene-demo-button-light" : "scene-demo-button-dark",
            )}
          >
            Book a Demo
          </span>
        )
      ) : null}
    </>
  );
}

type FrameScrubberProps = {
  disabled: boolean;
  offset: number;
  onScrub: (deltaFrames: number) => void;
};

function FrameScrubber({ disabled, offset, onScrub }: FrameScrubberProps) {
  const isDraggingRef = useRef(false);
  const lastClientXRef = useRef(0);

  const applyPixelDelta = (pixelDelta: number) => {
    const frameDelta = Math.round(pixelDelta * frameScrubFramesPerPixel);

    if (frameDelta !== 0) {
      onScrub(frameDelta);
    }
  };

  const startScrub = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled) {
      return;
    }

    isDraggingRef.current = true;
    lastClientXRef.current = event.clientX;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveScrub = (event: PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current || disabled) {
      return;
    }

    const pixelDelta = event.clientX - lastClientXRef.current;
    lastClientXRef.current = event.clientX;
    applyPixelDelta(pixelDelta);
  };

  const stopScrub = (event: PointerEvent<HTMLDivElement>) => {
    isDraggingRef.current = false;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) {
      return;
    }

    const step = event.shiftKey ? 100 : 10;

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onScrub(-step);
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      onScrub(step);
    }
  };

  return (
    <div className={cn("grid gap-2.5", disabled && "opacity-55")}>
      <span className="flex items-center justify-between gap-4 text-sm font-semibold text-[var(--muted-foreground)]">
        <span>Frame</span>
        <strong className="text-xs text-[var(--primary)]">
          {formatSignedOffset(offset)}
        </strong>
      </span>
      <div
        aria-disabled={disabled}
        aria-label="Frame"
        className={cn(
          "relative h-12 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--background)]/44 touch-none select-none outline-none transition focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
          disabled ? "cursor-not-allowed" : "cursor-ew-resize hover:bg-[var(--accent)]",
        )}
        data-frame-offset={offset}
        data-frame-scrubber
        onKeyDown={handleKeyDown}
        onPointerCancel={stopScrub}
        onPointerDown={startScrub}
        onPointerMove={moveScrub}
        onPointerUp={stopScrub}
        role="button"
        tabIndex={disabled ? -1 : 0}
      >
        <div className="absolute inset-y-0 left-1/2 w-px bg-[var(--primary)]/70" />
        <div className="absolute inset-x-3 top-1/2 h-1 -translate-y-1/2 rounded-full bg-[var(--muted)]" />
        <div className="absolute left-1/2 top-1/2 size-5 -translate-x-1/2 -translate-y-1/2 rounded-md border border-[var(--primary)] bg-[var(--background)] shadow-sm" />
        <div className="pointer-events-none absolute inset-y-0 left-0 w-12 bg-gradient-to-r from-[var(--background)]/90 to-transparent" />
        <div className="pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-[var(--background)]/90 to-transparent" />
      </div>
    </div>
  );
}

function formatSignedOffset(value: number) {
  const roundedValue = Math.round(value);

  if (roundedValue > 0) {
    return `+${roundedValue}`;
  }

  return roundedValue.toString();
}

type SwatchFieldProps = {
  activePaletteId: string;
  label: string;
  onChange: (value: string) => void;
  onPaletteChange: (paletteId: string) => void;
  value: string;
};

type ThemeToggleProps = {
  onChange: (value: UiTheme) => void;
  value: UiTheme;
};

function ThemeToggle({ onChange, value }: ThemeToggleProps) {
  return (
    <div aria-label="Theme mode" className="flex shrink-0 items-center gap-1">
      {([
        { icon: Sun, label: "Light mode", value: "light" },
        { icon: Moon, label: "Dark mode", value: "dark" },
      ] as const).map((theme) => {
        const Icon = theme.icon;
        const isSelected = value === theme.value;

        return (
          <button
            aria-label={theme.label}
            aria-pressed={isSelected}
            className={cn(
              "inline-flex size-7 items-center justify-center rounded text-[var(--muted-foreground)] opacity-35 transition hover:bg-[var(--accent)] hover:text-[var(--foreground)] hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:opacity-100",
              isSelected && "text-[var(--foreground)] opacity-100",
            )}
            key={theme.value}
            onClick={() => onChange(theme.value)}
            type="button"
          >
            <Icon className="size-4" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}

type FormatFieldProps = {
  onChange: (value: FormatOption) => void;
  value: FormatOption;
};

function FormatField({ onChange, value }: FormatFieldProps) {
  return (
    <div className="grid gap-2.5">
      <span className="text-sm font-semibold text-[var(--muted-foreground)]">
        Format
      </span>
      <div className="grid grid-cols-3 gap-2">
        {formatOptions.map((option) => (
          <Button
            className={cn(
              "h-auto min-h-12 flex-col gap-0.5 px-2 py-2",
              option.label === value.label &&
                "border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-foreground)] hover:bg-[var(--primary)]/90",
            )}
            key={option.label}
            onClick={() => onChange(option)}
            type="button"
            variant="outline"
          >
            <span>{option.label}</span>
            <span className="text-[0.62rem] font-semibold opacity-70">
              {option.name}
            </span>
          </Button>
        ))}
      </div>
    </div>
  );
}

type TabsProps = {
  onChange: (value: ActiveTab) => void;
  value: ActiveTab;
};

function Tabs({ onChange, value }: TabsProps) {
  return (
    <div
      className="grid grid-cols-2 rounded-md border border-[var(--border)] bg-[var(--background)]/38 p-1"
      role="tablist"
      aria-label="Generator sections"
    >
      <button
        className={cn(
          "min-h-9 rounded px-3 text-sm font-semibold text-[var(--muted-foreground)] transition",
          value === "generate" &&
            "bg-[var(--primary)] text-[var(--primary-foreground)]",
        )}
        type="button"
        role="tab"
        aria-selected={value === "generate"}
        onClick={() => onChange("generate")}
      >
        Generate
      </button>
      <button
        className={cn(
          "min-h-9 rounded px-3 text-sm font-semibold text-[var(--muted-foreground)] transition",
          value === "gallery" &&
            "bg-[var(--primary)] text-[var(--primary-foreground)]",
        )}
        type="button"
        role="tab"
        aria-selected={value === "gallery"}
        onClick={() => onChange("gallery")}
      >
        Gallery
      </button>
    </div>
  );
}

function gallerySaveStatusLabel(status: GallerySaveStatus) {
  if (status === "loading") {
    return "Loading file";
  }

  if (status === "saving") {
    return "Saving to file";
  }

  if (status === "error") {
    return "File save failed";
  }

  return "Saved to file";
}

type GalleryProps = {
  items: VisualSnapshot[];
  onCreateSection: (name: string) => void;
  onMoveVisual: (visualId: string, sectionId: string) => void;
  onSelect: (visual: VisualSnapshot) => void;
  onToggleSection: (sectionId: string) => void;
  saveStatus: GallerySaveStatus;
  sections: GallerySection[];
  selectedVisualId: string | null;
};

function Gallery({
  items,
  onCreateSection,
  onMoveVisual,
  onSelect,
  onToggleSection,
  saveStatus,
  sections,
  selectedVisualId,
}: GalleryProps) {
  const [newSectionName, setNewSectionName] = useState("");

  const handleCreateSection = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const trimmedName = newSectionName.trim();

    if (!trimmedName) {
      return;
    }

    onCreateSection(trimmedName);
    setNewSectionName("");
  };

  return (
    <section className="grid gap-4">
      <div className="flex items-end justify-between gap-4">
        <h2 className="text-base font-bold text-[var(--foreground)]">Gallery</h2>
        <div className="grid justify-items-end gap-1">
          <span className="text-xs font-semibold text-[var(--muted-foreground)]">
            {items.length} saved
          </span>
          <span
            className={cn(
              "text-[0.64rem] font-bold uppercase",
              saveStatus === "error"
                ? "text-[var(--destructive)]"
                : "text-[var(--muted-foreground)]",
            )}
            data-gallery-save-status={saveStatus}
          >
            {gallerySaveStatusLabel(saveStatus)}
          </span>
        </div>
      </div>

      <form className="grid grid-cols-[1fr_auto] gap-2" onSubmit={handleCreateSection}>
        <input
          aria-label="Section name"
          className="h-10 min-w-0 rounded-md border border-[var(--border)] bg-[var(--background)]/52 px-3 text-sm font-semibold text-[var(--foreground)] outline-none transition placeholder:text-[var(--muted-foreground)] focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          onChange={(event) => setNewSectionName(event.target.value)}
          placeholder="Section name"
          value={newSectionName}
        />
        <Button type="submit" variant="outline">
          Create section
        </Button>
      </form>

      <div className="grid gap-3">
        {sections.map((section) => {
          const sectionItems = items.filter((item) => item.sectionId === section.id);

          return (
            <section
              className="overflow-hidden rounded-md border border-[var(--border)] bg-[var(--background)]/24"
              data-gallery-section={section.name}
              data-section-id={section.id}
              key={section.id}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const visualId = event.dataTransfer.getData("text/plain");

                if (visualId) {
                  onMoveVisual(visualId, section.id);
                }
              }}
            >
              <button
                aria-expanded={section.isOpen}
                className="flex min-h-11 w-full items-center justify-between gap-3 px-3 text-left text-sm font-bold text-[var(--foreground)] transition hover:bg-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-inset"
                onClick={() => onToggleSection(section.id)}
                type="button"
              >
                <span className="truncate">{section.name}</span>
                <span className="shrink-0 text-xs font-semibold text-[var(--muted-foreground)]">
                  {sectionItems.length}
                </span>
              </button>

              {section.isOpen ? (
                <div className="grid gap-3 border-t border-[var(--border)] p-3">
                  {sectionItems.length === 0 ? (
                    <div className="rounded-md border border-dashed border-[var(--border)] p-4 text-sm font-semibold text-[var(--muted-foreground)]">
                      Drop visuals here.
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 gap-2">
                      {sectionItems.map((item) => (
                        <button
                          className={cn(
                            "grid min-w-0 gap-1 rounded-md border border-[var(--border)] bg-[var(--background)]/36 p-1.5 text-left transition hover:bg-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)]",
                            item.id === selectedVisualId &&
                              "border-[var(--primary)] ring-2 ring-[var(--primary)]/80",
                          )}
                          data-gallery-item
                          data-visual-id={item.id}
                          draggable
                          key={item.id}
                          onClick={() => onSelect(item)}
                          onDragStart={(event) => {
                            event.dataTransfer.effectAllowed = "move";
                            event.dataTransfer.setData("text/plain", item.id);
                          }}
                          type="button"
                        >
                          <img
                            alt=""
                            className="aspect-square w-full rounded border border-[var(--border)] object-cover"
                            draggable={false}
                            src={item.thumbnail}
                          />
                          <span className="truncate text-[0.68rem] font-bold text-[var(--foreground)]">
                            {item.name}
                          </span>
                          <span className="text-[0.62rem] font-semibold text-[var(--muted-foreground)]">
                            {item.format.label}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
    </section>
  );
}

function SwatchField({
  activePaletteId,
  label,
  onChange,
  onPaletteChange,
  value,
}: SwatchFieldProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const activePalette = getPaletteGroup(activePaletteId);
  const selectedColor = findPaletteColor(value);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const closeOnPointerDown = (event: globalThis.PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);

    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isOpen]);

  const selectColor = (colorValue: string) => {
    onChange(colorValue);
    setIsOpen(false);
  };

  return (
    <div className="relative grid gap-2.5" ref={menuRef}>
      <span className="text-sm font-semibold text-[var(--muted-foreground)]">
        {label}
      </span>
      <button
        aria-expanded={isOpen}
        aria-haspopup="menu"
        className="flex h-10 w-full items-center justify-between gap-3 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-left text-sm font-semibold text-[var(--foreground)] transition hover:bg-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        data-swatch-trigger={label}
        onClick={() => setIsOpen((currentValue) => !currentValue)}
        type="button"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span
            className="size-5 shrink-0 rounded border border-[var(--border)]"
            style={{ background: value }}
          />
          <span className="truncate">{selectedColor?.name ?? value}</span>
        </span>
        <span className="shrink-0 text-xs text-[var(--muted-foreground)]">
          {activePalette.name}
        </span>
      </button>
      {isOpen ? (
        <div
          className="absolute left-0 right-0 top-[calc(100%+6px)] z-30 rounded-md border border-[var(--border)] bg-[var(--popover)] p-2 text-[var(--popover-foreground)] shadow-lg"
          role="menu"
        >
          <div className="grid gap-2">
            <div className="grid grid-cols-2 gap-1">
              {paletteGroups.map((palette) => (
                <button
                  className={cn(
                    "min-h-8 rounded px-2 text-sm font-semibold transition hover:bg-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
                    palette.id === activePalette.id &&
                      "bg-[var(--primary)] text-[var(--primary-foreground)]",
                  )}
                  key={palette.id}
                  onClick={() => onPaletteChange(palette.id)}
                  type="button"
                >
                  {palette.name}
                </button>
              ))}
            </div>
            <div className="h-px bg-[var(--border)]" />
            <div className="grid grid-cols-6 gap-2">
              {activePalette.colors.map((color) => (
                <button
                  aria-label={color.name}
                  className={cn(
                    "h-9 rounded-md border border-[var(--border)] shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)]",
                    color.value.toLowerCase() === value.toLowerCase() &&
                      "border-[var(--foreground)] ring-2 ring-[var(--primary)]",
                  )}
                  key={color.value}
                  onClick={() => selectColor(color.value)}
                  role="menuitem"
                  style={{ background: color.value }}
                  title={color.name}
                  type="button"
                />
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function createRandomBlob(index: number): BlobConfig {
  return {
    bend: randomBetween(-1.05, 1.05),
    color: randomPaletteColor(),
    id: `blob-${index}`,
    name: `Anchor ${index + 1}`,
    opacity: randomBetween(0.56, 1),
    rotation: randomBetween(-Math.PI, Math.PI),
    size: randomBetween(0.18, 0.5),
    stretch: randomBetween(0.62, 2.2),
    taper: randomBetween(-0.82, 0.82),
    x: randomBetween(0.14, 0.86),
    y: randomBetween(0.14, 0.86),
  };
}

function getPaletteGroup(paletteId: string) {
  return (
    paletteGroups.find((palette) => palette.id === paletteId) ??
    paletteGroups[0]
  );
}

function findPaletteColor(value: string) {
  const normalizedValue = value.toLowerCase();

  return paletteGroups
    .flatMap((palette) => palette.colors)
    .find((color) => color.value.toLowerCase() === normalizedValue);
}

function randomPaletteColor(paletteId = paletteGroups[0].id) {
  const colors = getPaletteGroup(paletteId).colors;

  return colors[Math.floor(Math.random() * colors.length)].value;
}

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function clampFrame(frame: number) {
  return Math.min(meshFrameMax, Math.max(0, frame));
}

function getLoopFadeAmount(elapsedMs: number, durationMs: number) {
  const fadeDurationMs = Math.min(3000, durationMs * 0.25);
  const holdDurationMs = Math.min(250, durationMs * 0.05);
  const fadeEndMs = durationMs - holdDurationMs;
  const fadeStartMs = fadeEndMs - fadeDurationMs;
  const progress = Math.min(
    1,
    Math.max(0, (elapsedMs - fadeStartMs) / fadeDurationMs),
  );

  return progress * progress * (3 - 2 * progress);
}

function waitForNextAnimationFrame() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function waitForFontsReady() {
  if (!("fonts" in document)) {
    return;
  }

  await document.fonts.ready.catch(() => undefined);
}

function normalizeMesh(meshToNormalize: MeshConfig): MeshConfig {
  return {
    audioReactivity: finiteNumber(
      normalizeAudioReactivity(meshToNormalize.audioReactivity),
      initialMesh.audioReactivity,
    ),
    audioSmoothness: finiteNumber(
      meshToNormalize.audioSmoothness,
      initialMesh.audioSmoothness,
    ),
    distortion: finiteNumber(meshToNormalize.distortion, initialMesh.distortion),
    frame: clampFrame(Number.isFinite(meshToNormalize.frame) ? meshToNormalize.frame : 0),
    grainMixer: Number.isFinite(meshToNormalize.grainMixer)
      ? meshToNormalize.grainMixer
      : fixedGrainMixer,
    grainOverlay: fixedGrainOverlay,
    idleWarp: finiteNumber(meshToNormalize.idleWarp, initialMesh.idleWarp),
    motionBlur: finiteNumber(meshToNormalize.motionBlur, 0),
    scale: finiteNumber(meshToNormalize.scale, initialMesh.scale),
    speed: finiteNumber(meshToNormalize.speed, initialMesh.speed),
    swirl: finiteNumber(meshToNormalize.swirl, initialMesh.swirl),
  };
}

function normalizeAudioReactivity(value: number) {
  if (!Number.isFinite(value)) {
    return initialMesh.audioReactivity;
  }

  return value <= 1 ? value * 10 : value;
}

function normalizeBlob(blobToNormalize: BlobConfig, index: number): BlobConfig {
  const fallback = initialBlobs[index] ?? initialBlobs[0];

  return {
    bend: finiteNumber(blobToNormalize.bend, fallback.bend),
    color: typeof blobToNormalize.color === "string"
      ? blobToNormalize.color
      : fallback.color,
    id: typeof blobToNormalize.id === "string" && blobToNormalize.id
      ? blobToNormalize.id
      : fallback.id,
    name: typeof blobToNormalize.name === "string" && blobToNormalize.name
      ? blobToNormalize.name
      : fallback.name,
    opacity: finiteNumber(blobToNormalize.opacity, fallback.opacity),
    rotation: finiteNumber(blobToNormalize.rotation, fallback.rotation),
    size: finiteNumber(blobToNormalize.size, fallback.size),
    stretch: finiteNumber(blobToNormalize.stretch, fallback.stretch),
    taper: finiteNumber(blobToNormalize.taper, fallback.taper),
    x: finiteNumber(blobToNormalize.x, fallback.x),
    y: finiteNumber(blobToNormalize.y, fallback.y),
  };
}

function cloneBlobs(blobsToClone: BlobConfig[]) {
  return blobsToClone.map((blob, index) => normalizeBlob(blob, index));
}

function cloneFormat(formatToClone: FormatConfig): FormatConfig {
  return { ...formatToClone };
}

function getFormatOption(label: string) {
  return (
    formatOptions.find((option) => option.label === label) ?? formatOptions[0]
  );
}

function getSingleFormatOption(label: string) {
  return (
    singleFormatOptions.find((option) => option.label === label) ??
    singleFormatOptions[0]
  );
}

function getPreviewFrameClass(label: string) {
  if (label === "1:1") return "format-frame-square";
  if (label === "16:9") return "format-frame-16x9";
  if (label === "9:16") return "format-frame-9x16";
  if (label === "4:3") return "format-frame-4x3";
  if (label === "3:4") return "format-frame-3x4";
  return "format-frame-square";
}


function formatSlug(formatToSlug: FormatConfig) {
  return formatToSlug.label.replace(":", "x").toLowerCase();
}

async function captureTargetPng(
  handle: ShaderStageHandle,
  scale: 1 | 2,
  format: FormatConfig,
) {
  const canvas = handle.getCanvas();

  if (!canvas) {
    return null;
  }

  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = Math.max(
    1,
    Math.round((format.exportWidth ?? canvas.width) * scale),
  );
  exportCanvas.height = Math.max(
    1,
    Math.round((format.exportHeight ?? canvas.height) * scale),
  );

  const context = exportCanvas.getContext("2d");

  if (!context) {
    return null;
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(canvas, 0, 0, exportCanvas.width, exportCanvas.height);

  return exportCanvas.toDataURL("image/png");
}

async function loadOverlayImage(overlay: VisualOverlay) {
  const overlaySource = getOverlayDataUrl(overlay);

  if (!overlaySource) {
    return null;
  }

  const image = new Image();
  image.decoding = "async";
  image.src = overlaySource;
  await image.decode();

  return image;
}

async function loadTopLogoImage(overlay: VisualOverlay) {
  const svg = getOverlaySvg({ ...overlay, asset: "logo" });

  if (!svg) {
    return null;
  }

  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const image = new Image();
  image.decoding = "async";
  image.src = src;
  await image.decode();

  return image;
}

async function loadQrCodeImage(tone: OverlayTone) {
  const image = new Image();
  image.decoding = "async";
  image.src = getQrCodeDataUrl(tone);
  await image.decode();

  return image;
}

function drawOverlay(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  options: {
    audioLevel: number;
    audioSpectrum: number[];
    image: HTMLImageElement | null;
    qrImage: HTMLImageElement | null;
    topLogoImage: HTMLImageElement | null;
    overlay: VisualOverlay;
  },
) {
  const { audioLevel, audioSpectrum, image, qrImage, topLogoImage, overlay } = options;
  void audioLevel;
  const color = overlay.tone === "dark" ? "#020617" : "#ffffff";

  context.save();
  context.globalAlpha = 1;
  context.filter = "none";

  if (overlay.asset === "waveform") {
    drawWaveformOverlay(
      context,
      width,
      height,
      audioSpectrum,
      color,
    );
  } else if (image && overlay.asset !== "none") {
    const imageRatio = image.naturalWidth / image.naturalHeight;
    const maxWidth = overlay.asset === "star" ? width * 0.22 : width * 0.62;
    const maxHeight = overlay.asset === "star" ? height * 0.22 : height * 0.22;
    let drawWidth = maxWidth;
    let drawHeight = drawWidth / imageRatio;

    if (drawHeight > maxHeight) {
      drawHeight = maxHeight;
      drawWidth = drawHeight * imageRatio;
    }

    context.drawImage(
      image,
      (width - drawWidth) / 2,
      (height - drawHeight) / 2,
      drawWidth,
      drawHeight,
    );
  }

  context.globalAlpha = 1;
  context.filter = "none";

  if (overlay.showTopLogo || overlay.showBottomLeftSlogan || overlay.showBottomCta) {
    drawSceneBottomBar(
      context, width, height, overlay.tone,
      overlay.showTopLogo ? topLogoImage : null,
      overlay.showTopLogo,
      overlay.showBottomLeftSlogan,
      overlay.showBottomCta ? overlay.bottomRight : null,
      qrImage,
    );
  }

  context.restore();
}

function drawWaveformOverlay(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  audioSpectrum: number[],
  color: string,
) {
  const style = getWaveformStyle();
  const totalBars = 64;
  const halfBars = totalBars / 2;
  const noiseFloor = style.noiseFloor;
  const centerEnvelopePower = style.centerEnvelopePower;
  const sideFloor = style.sideFloor;
  const sideMotionMix = style.sideMotionMix;
  const widthFactor = style.widthFactor;
  const centerGain = style.centerGain;
  const edgeGain = style.edgeGain;
  const sceneWaveBounds = getSceneWaveBounds(width, height);
  const overlayWidth = sceneWaveBounds.width;
  const overlayHeight = sceneWaveBounds.height;
  const waveformAmplitudeScale = sceneWaveBounds.amplitudeScale;
  const left = (width - overlayWidth) / 2;
  const top = (height - overlayHeight) / 2;
  const gap = Math.max(2, overlayWidth * 0.0046);
  const barWidth = Math.max(2, (overlayWidth - gap * (totalBars - 1)) / totalBars);

  if (style.useStarProfile) {
    const frameMax = audioSpectrum.reduce(
      (m, b) => Math.max(m, Math.max(0, (b - noiseFloor) / (1 - noiseFloor))),
      0.001,
    );
    _starNormalizedPeak = Math.max(_starNormalizedPeak * 0.9997, frameMax);
  }

  const drawBars = (opacityMultiplier: number) => {
    context.fillStyle = color;
    for (let index = 0; index < totalBars; index++) {
      const mirroredIndex = index < halfBars ? halfBars - 1 - index : index - halfBars;
      const centeredProgress = mirroredIndex / Math.max(halfBars - 1, 1);
      const compressedProgress = 0.5 + (centeredProgress - 0.5) * widthFactor;
      const sourceProgress = Math.max(0, Math.min(1, compressedProgress));
      const sourceIndex = Math.floor(sourceProgress * (audioSpectrum.length - 1));
      const band = Math.max(0, Math.min(1, audioSpectrum[sourceIndex] ?? 0));
      const normalizedBand = Math.max(0, (band - noiseFloor) / (1 - noiseFloor));
      const centerDistance =
        Math.abs(index - (totalBars - 1) / 2) / ((totalBars - 1) / 2);
      const centerEnvelope =
        sideFloor + (1 - centerDistance) ** centerEnvelopePower * (1 - sideFloor);
      const gainWeight = (1 - centerDistance) ** centerEnvelopePower;
      const gain = edgeGain + (centerGain - edgeGain) * gainWeight;
      const effectiveBand =
        normalizedBand * sideMotionMix + normalizedBand * centerEnvelope * (1 - sideMotionMix);
      const boostedBand = Math.max(0, Math.min(1, effectiveBand * gain * style.verticalGain));
      const bell = 1 + style.bellBoost * (1 - centerDistance) ** 6;
      const barHeight = style.useStarProfile
        ? (normalizedBand / _starNormalizedPeak) *
          (STAR_BAR_PROFILE[mirroredIndex] ?? 1) *
          overlayHeight *
          waveformAmplitudeScale
        : boostedBand * overlayHeight * bell * waveformAmplitudeScale;

      if (barHeight <= 0) {
        continue;
      }

      const x = left + index * (barWidth + gap);
      const y = top + (overlayHeight - barHeight) / 2;
      context.globalAlpha = opacityMultiplier * getWaveformBarOpacity(mirroredIndex);
      const radius = Math.min(barWidth / 2, 5);
      drawRoundedRect(context, x, y, barWidth, barHeight, radius);
      context.fill();
    }
  };

  drawBars(1);
  context.globalAlpha = 1;
}

function drawVisiblePreviewOverlay(
  context: CanvasRenderingContext2D,
  formatLabel: string,
  audioSpectrum: number[],
  overlay: VisualOverlay,
  topLogoImage: HTMLImageElement | null,
) {
  const frameElement = getVisibleFormatFrame(formatLabel);

  if (!frameElement) {
    return false;
  }

  context.save();
  context.globalAlpha = 1;
  context.filter = "none";

  if (overlay.asset === "waveform") {
    drawVisibleWaveform(context, frameElement, audioSpectrum, overlay.tone);
  }

  if (overlay.showTopLogo && topLogoImage) {
    drawVisibleLogo(context, frameElement, topLogoImage);
  }

  if (overlay.showBottomLeftSlogan || overlay.showBottomCta) {
    drawVisibleBottomContent(context, frameElement);
  }

  context.restore();

  return true;
}

function getVisibleFormatFrame(formatLabel: string) {
  return Array.from(document.querySelectorAll<HTMLElement>(".format-frame"))
    .find((element) => element.dataset.formatLabel === formatLabel) ?? null;
}

function getExportRect(
  element: Element,
  frameElement: HTMLElement,
  canvasWidth: number,
  canvasHeight: number,
) {
  const frameRect = frameElement.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  const scaleX = canvasWidth / Math.max(frameRect.width, 1);
  const scaleY = canvasHeight / Math.max(frameRect.height, 1);

  return {
    height: elementRect.height * scaleY,
    width: elementRect.width * scaleX,
    x: (elementRect.left - frameRect.left) * scaleX,
    y: (elementRect.top - frameRect.top) * scaleY,
  };
}

function drawVisibleWaveform(
  context: CanvasRenderingContext2D,
  frameElement: HTMLElement,
  audioSpectrum: number[],
  tone: OverlayTone,
) {
  const waveElement = frameElement.querySelector<HTMLElement>(".sound-wave-overlay");
  const trackElement = frameElement.querySelector<HTMLElement>(".sound-wave-overlay-track");
  const firstBarElement = frameElement.querySelector<HTMLElement>(".sound-wave-overlay-bar");

  if (!waveElement || !trackElement || !firstBarElement) {
    return;
  }

  const style = getWaveformStyle();
  const totalBars = 64;
  const halfBars = totalBars / 2;
  const noiseFloor = style.noiseFloor;
  const centerEnvelopePower = style.centerEnvelopePower;
  const sideFloor = style.sideFloor;
  const sideMotionMix = style.sideMotionMix;
  const widthFactor = style.widthFactor;
  const centerGain = style.centerGain;
  const edgeGain = style.edgeGain;
  const measuredWaveRect = getExportRect(
    waveElement,
    frameElement,
    context.canvas.width,
    context.canvas.height,
  );
  const waveRect = {
    ...measuredWaveRect,
    x: (context.canvas.width - measuredWaveRect.width) / 2,
    y: (context.canvas.height - measuredWaveRect.height) / 2,
  };
  const firstBarRect = getExportRect(firstBarElement, frameElement, context.canvas.width, context.canvas.height);
  const frameRect = frameElement.getBoundingClientRect();
  const scaleX = context.canvas.width / Math.max(frameRect.width, 1);
  const trackStyle = getComputedStyle(trackElement);
  const gap = Math.max(0, parseFloat(trackStyle.columnGap || trackStyle.gap || "0") * scaleX);
  const barWidth =
    firstBarRect.width > 0
      ? firstBarRect.width
      : Math.max(2, (waveRect.width - gap * (totalBars - 1)) / totalBars);
  const barsWidth = totalBars * barWidth + (totalBars - 1) * gap;
  const startX = waveRect.x + (waveRect.width - barsWidth) / 2;
  const color = tone === "dark" ? "#020617" : "#ffffff";

  context.fillStyle = color;
  context.globalAlpha = 1;

  for (let index = 0; index < totalBars; index++) {
    const mirroredIndex = index < halfBars ? halfBars - 1 - index : index - halfBars;
    const centeredProgress = mirroredIndex / Math.max(halfBars - 1, 1);
    const compressedProgress = 0.5 + (centeredProgress - 0.5) * widthFactor;
    const sourceProgress = Math.max(0, Math.min(1, compressedProgress));
    const sourceIndex = Math.floor(sourceProgress * (audioSpectrum.length - 1));
    const band = Math.max(0, Math.min(1, audioSpectrum[sourceIndex] ?? 0));
    const normalizedBand = Math.max(0, (band - noiseFloor) / (1 - noiseFloor));
    const centerDistance =
      Math.abs(index - (totalBars - 1) / 2) / ((totalBars - 1) / 2);
    const centerEnvelope =
      sideFloor + (1 - centerDistance) ** centerEnvelopePower * (1 - sideFloor);
    const gainWeight = (1 - centerDistance) ** centerEnvelopePower;
    const gain = edgeGain + (centerGain - edgeGain) * gainWeight;
    const shapedBand =
      normalizedBand * sideMotionMix + normalizedBand * centerEnvelope * (1 - sideMotionMix);
    const effectiveBand = Math.max(0, Math.min(1, shapedBand * gain));
    const bell = 1 + style.bellBoost * (1 - centerDistance) ** 6;
    const barHeight = Math.max(0, effectiveBand * waveRect.height * bell);

    if (barHeight <= 0) {
      continue;
    }

    const x = startX + index * (barWidth + gap);
    const y = waveRect.y + (waveRect.height - barHeight) / 2;
    const radius = Math.min(barWidth / 2, 5 * scaleX);
    context.globalAlpha = getWaveformBarOpacity(mirroredIndex);
    drawRoundedRect(context, x, y, barWidth, barHeight, radius);
    context.fill();
  }

  context.globalAlpha = 1;
}

function drawVisibleLogo(
  context: CanvasRenderingContext2D,
  frameElement: HTMLElement,
  topLogoImage: HTMLImageElement,
) {
  const logoElement = frameElement.querySelector<HTMLElement>(".scene-logo");

  if (!logoElement) {
    return;
  }

  const rect = getExportRect(logoElement, frameElement, context.canvas.width, context.canvas.height);
  context.globalAlpha = 1;
  context.filter = "none";
  context.drawImage(topLogoImage, rect.x, rect.y, rect.width, rect.height);
}

function drawVisibleBottomContent(
  context: CanvasRenderingContext2D,
  frameElement: HTMLElement,
) {
  const sloganElements = Array.from(frameElement.querySelectorAll<HTMLElement>(".scene-bottom-slogan"));
  const buttonElement = frameElement.querySelector<HTMLElement>(".scene-demo-button");
  const qrElement = frameElement.querySelector<HTMLImageElement>(".scene-qr-code");

  sloganElements.forEach((sloganElement) => {
    const sloganStyle = getComputedStyle(sloganElement);
    const sloganColor = sloganStyle.color || "#ffffff";
    const wordElements = Array.from(sloganElement.querySelectorAll<HTMLElement>(".scene-slogan-word"));
    const align = sloganElement.dataset.align === "right" ? "right" : "left";

    context.fillStyle = sloganColor;
    context.textAlign = align;
    context.textBaseline = "top";
    setCanvasFontFromStyle(context, sloganStyle, frameElement, "300");
    setCanvasLetterSpacing(context, sloganStyle, frameElement);

    wordElements.forEach((wordElement) => {
      const rect = getExportRect(wordElement, frameElement, context.canvas.width, context.canvas.height);
      context.fillText(wordElement.textContent ?? "", align === "right" ? rect.x + rect.width : rect.x, rect.y);
    });

    setCanvasLetterSpacing(context, null, frameElement);
  });

  if (buttonElement) {
    const rect = getExportRect(buttonElement, frameElement, context.canvas.width, context.canvas.height);
    const buttonStyle = getComputedStyle(buttonElement);
    const radius = rect.height / 2;
    const blurRadius = Math.max(6, Math.min(context.canvas.width, context.canvas.height) * 0.012);

    drawBlurredBackdrop(context, rect.x, rect.y, rect.width, rect.height, radius, blurRadius);
    context.fillStyle = buttonStyle.backgroundColor || "rgba(255,255,255,0.25)";
    context.globalAlpha = 1;
    drawRoundedRect(context, rect.x, rect.y, rect.width, rect.height, radius);
    context.fill();

    context.fillStyle = buttonStyle.color || "#ffffff";
    context.textAlign = "center";
    context.textBaseline = "middle";
    setCanvasFontFromStyle(context, buttonStyle, frameElement);
    setCanvasLetterSpacing(context, buttonStyle, frameElement);
    context.fillText(
      buttonElement.textContent?.trim() ?? "",
      rect.x + rect.width / 2,
      rect.y + rect.height / 2,
    );
    setCanvasLetterSpacing(context, null, frameElement);
  }

  if (qrElement && qrElement.complete && qrElement.naturalWidth > 0) {
    const rect = getExportRect(qrElement, frameElement, context.canvas.width, context.canvas.height);
    context.globalAlpha = 1;
    context.filter = "none";
    context.drawImage(qrElement, rect.x, rect.y, rect.width, rect.height);
  }
}

function setCanvasFontFromStyle(
  context: CanvasRenderingContext2D,
  style: CSSStyleDeclaration,
  frameElement: HTMLElement,
  fontWeight?: string,
) {
  const frameRect = frameElement.getBoundingClientRect();
  const scaleY = context.canvas.height / Math.max(frameRect.height, 1);
  const fontSize = Math.max(1, parseFloat(style.fontSize || "16") * scaleY);
  context.font = `${style.fontStyle || "normal"} ${style.fontVariant || "normal"} ${
    fontWeight ?? style.fontWeight ?? "400"
  } ${fontSize}px ${style.fontFamily || "sans-serif"}`;
}

function setCanvasLetterSpacing(
  context: CanvasRenderingContext2D,
  style: CSSStyleDeclaration | null,
  frameElement: HTMLElement,
) {
  const writableContext = context as CanvasRenderingContext2D & {
    letterSpacing?: string;
  };

  if (typeof writableContext.letterSpacing !== "string") {
    return;
  }

  if (!style) {
    writableContext.letterSpacing = "0px";
    return;
  }

  const frameRect = frameElement.getBoundingClientRect();
  const scaleX = context.canvas.width / Math.max(frameRect.width, 1);
  const letterSpacing = parseFloat(style.letterSpacing || "0");
  writableContext.letterSpacing = Number.isFinite(letterSpacing)
    ? `${letterSpacing * scaleX}px`
    : "0px";
}

function getSceneWaveBounds(
  width: number,
  height: number,
) {
  const ratio = width / height;
  const isSquare = Math.abs(ratio - 1) < 0.01;
  const isThreeByFour = Math.abs(ratio - 3 / 4) < 0.01;
  const isNineBySixteen = Math.abs(ratio - 9 / 16) < 0.01;

  const waveformBoxScale = isSquare
    ? 0.757576
    : isThreeByFour
      ? 0.984848
      : isNineBySixteen
        ? 0.738636
        : 1;
  const overlayWidth =
    isSquare || isThreeByFour || isNineBySixteen
      ? width * 0.5 * waveformBoxScale
      : width * 0.78;
  const overlayHeight =
    isSquare || isThreeByFour || isNineBySixteen
      ? height * 0.32 * waveformBoxScale
      : height * 0.32;

  return {
    amplitudeScale: focusedWaveformAmplitudeScale,
    height: overlayHeight,
    width: overlayWidth,
  };
}

function getWaveformBarOpacity(distanceFromCenterBar: number) {
  return Math.max(0, 1 - distanceFromCenterBar * 0.05);
}

function drawSceneBottomBar(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  tone: OverlayTone,
  logoImage: HTMLImageElement | null,
  showLogo: boolean,
  showLeftSlogan: boolean,
  bottomRight: BottomRightOverlay | null,
  qrImage: HTMLImageElement | null,
) {
  const isLight = tone !== "dark";
  const textColor = isLight ? "#ffffff" : "#01151e";
  const sizeUnit = Math.min(width, height);
  const isSquare = Math.abs(width / height - 1) < 0.01;
  const isSixteenByNine = Math.abs(width / height - 16 / 9) < 0.01;
  const isFourByThree = Math.abs(width / height - 4 / 3) < 0.01;
  const isNineBySixteen = Math.abs(width / height - 9 / 16) < 0.01;
  const isThreeByFour = Math.abs(width / height - 3 / 4) < 0.01;
  const logoScale = isNineBySixteen
    ? 1.936
    : isThreeByFour
      ? 1.452
    : isSixteenByNine
      ? 0.9
      : isFourByThree
        ? 0.9
        : isSquare
          ? 1.32
          : 1;
  const textScale = isNineBySixteen
    ? 1.936
    : isThreeByFour
      ? 1.452
    : isSixteenByNine
      ? 1
      : isSquare
        ? 1.32
        : 1;
  const buttonScale = isNineBySixteen
    ? 2.3232
    : isThreeByFour
      ? 1.7424
    : isSixteenByNine
      ? 1
      : isSquare
        ? 1.32
        : 1;
  const margin = Math.round(sizeUnit * 0.06);
  const logoTop = Math.round(sizeUnit * (isNineBySixteen ? 0.13125 : 0.075));

  context.save();

  if (showLogo && logoImage) {
    const logoH = Math.round(sizeUnit * 0.062 * logoScale);
    const logoW = Math.round(logoH * (logoImage.naturalWidth / logoImage.naturalHeight));
    context.drawImage(logoImage, margin, logoTop, logoW, logoH);
  }

  const fontSize = Math.round(sizeUnit * 0.04 * textScale);
  const bottomMargin = Math.round(sizeUnit * (isNineBySixteen ? 0.09 : 0.06));
  const sloganLines = ["Autonomous", "Revenue", "Engine"];
  const lineHeight = fontSize * 0.9;
  const textBlockHeight = lineHeight * sloganLines.length;
  const textTop = height - bottomMargin - textBlockHeight;

  const drawSlogan = (x: number, align: CanvasTextAlign) => {
    context.font = `400 ${fontSize}px "Bricolage Grotesque", Arial, sans-serif`;
    context.fillStyle = textColor;
    context.textAlign = align;
    context.letterSpacing = `-${fontSize * 0.05}px`;
    context.textBaseline = "top";
    sloganLines.forEach((line, index) => {
      context.fillText(line, x, textTop + index * lineHeight);
    });
    context.letterSpacing = "0px";
  };

  if (showLeftSlogan) {
    drawSlogan(margin, "left");
  }

  if (bottomRight) {
    const btnFontSize = Math.round(sizeUnit * 0.025 * buttonScale);

    if (bottomRight === "slogan") {
      drawSlogan(width - margin, "right");
      context.restore();
      return;
    }

    if (bottomRight === "qr") {
      const qrSize = textBlockHeight;
      const qrX = width - margin - qrSize;
      const qrY = height - bottomMargin - qrSize;
      if (qrImage) {
        context.drawImage(qrImage, qrX, qrY, qrSize, qrSize);
      }
      context.restore();
      return;
    }

    context.font = `500 ${btnFontSize}px Arial, sans-serif`;
    const label = "Book a Demo";
    const textW = context.measureText(label).width;
    const btnPadX = Math.round(sizeUnit * 0.046 * buttonScale);
    const btnPadY = Math.round(sizeUnit * 0.019 * buttonScale);
    const btnW = textW + btnPadX * 2;
    const btnH = btnFontSize + btnPadY * 2;
    const btnX = width - margin - btnW;
    const btnY = textTop + (textBlockHeight - btnH) / 2;
    drawBlurredBackdrop(context, btnX, btnY, btnW, btnH, btnH / 2, Math.max(6, sizeUnit * 0.012));
    context.fillStyle = isLight ? "rgba(255,255,255,0.25)" : "rgba(1,21,30,0.25)";
    drawRoundedRect(context, btnX, btnY, btnW, btnH, btnH / 2);
    context.fill();
    context.fillStyle = isLight ? "#ffffff" : "#01151e";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(label, btnX + btnW / 2, btnY + btnH / 2);
  }

  context.restore();
}

function drawBlurredBackdrop(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  blurRadius: number,
) {
  const pad = Math.ceil(blurRadius * 2);
  const sx = Math.max(0, Math.floor(x - pad));
  const sy = Math.max(0, Math.floor(y - pad));
  const sw = Math.min(context.canvas.width - sx, Math.ceil(width + pad * 2));
  const sh = Math.min(context.canvas.height - sy, Math.ceil(height + pad * 2));

  if (sw <= 0 || sh <= 0) {
    return;
  }

  const snapshot = document.createElement("canvas");
  snapshot.width = sw;
  snapshot.height = sh;
  const snapshotContext = snapshot.getContext("2d");

  if (!snapshotContext) {
    return;
  }

  snapshotContext.drawImage(context.canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  context.save();
  drawRoundedRect(context, x, y, width, height, radius);
  context.clip();
  context.filter = `blur(${blurRadius}px)`;
  context.drawImage(snapshot, sx, sy);
  context.restore();
}

function drawRoundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const clampedRadius = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.beginPath();
  context.moveTo(x + clampedRadius, y);
  context.lineTo(x + width - clampedRadius, y);
  context.arcTo(x + width, y, x + width, y + clampedRadius, clampedRadius);
  context.lineTo(x + width, y + height - clampedRadius);
  context.arcTo(
    x + width,
    y + height,
    x + width - clampedRadius,
    y + height,
    clampedRadius,
  );
  context.lineTo(x + clampedRadius, y + height);
  context.arcTo(x, y + height, x, y + height - clampedRadius, clampedRadius);
  context.lineTo(x, y + clampedRadius);
  context.arcTo(x, y, x + clampedRadius, y, clampedRadius);
  context.closePath();
}

function getOverlayDataUrl(overlay: VisualOverlay) {
  const svg = getOverlaySvg(overlay);

  if (!svg) {
    return null;
  }

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function getQrCodeDataUrl(tone: OverlayTone) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(getQrCodeSvg(tone))}`;
}

function getQrCodeSvg(tone: OverlayTone) {
  const color = tone === "light" ? "#ffffff" : "#000000";

  return `<svg width="464" height="464" viewBox="0 0 464 464" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M0 56V112H56H112V56V0H56H0V56ZM128 8V16H136H144V24V32H136H128V40V48H136H144V56V64H152H160V72V80H144H128V96V112H136H144V120V128H160H176V136V144H152H128V136V128H112H96V136V144H72H48V136V128H40H32V136V144H24H16V136V128H8H0V144V160H8H16V168V176H8H0V184V192H48H96V200V208H88H80V224V240H72H64V248V256H56H48V240V224H56H64V216V208H56H48V216V224H40H32V216V208H16H0V232V256H8H16V272V288H8H0V296V304H16H32V296V288H40H48V296V304H64H80V312V320H88H96V328V336H104H112V328V320H104H96V312V304H112H128V336V368H136H144V392V416H136H128V424V432H136H144V424V416H152H160V432V448H144H128V456V464H144H160V456V448H168H176V440V432H192H208V424V416H216H224V392V368H216H208V360V352H224H240V368V384H248H256V392V400H248H240V416V432H248H256V448V464H264H272V448V432H280H288V440V448H296H304V456V464H336H368V456V448H384H400V456V464H408H416V448V432H408H400V424V416H416H432V424V432H448H464V424V416H456H448V408V400H432H416V392V384H408H400V368V352H416H432V344V336H440H448V352V368H440H432V376V384H448H464V360V336H456H448V328V320H440H432V328V336H424H416V328V320H400H384V312V304H400H416V296V288H432H448V296V304H456H464V280V256H456H448V264V272H432H416V280V288H400H384V280V272H376H368V264V256H376H384V248V240H392H400V232V224H392H384V208V192H376H368V176V160H376H384V144V128H376H368V136V144H352H336V136V128H328H320V120V112H328H336V104V96H328H320V104V112H312H304V104V96H296H288V88V80H296H304V72V64H312H320V56V48H304H288V40V32H296H304V16V0H296H288V8V16H280H272V32V48H256H240V64V80H224H208V72V64H200H192V72V80H184H176V64V48H200H224V40V32H216H208V24V16H224H240V24V32H248H256V16V0H224H192V16V32H184H176V16V0H152H128V8ZM352 56V112H408H464V56V0H408H352V56ZM96 56V96H56H16V56V16H56H96V56ZM320 24V32H328H336V24V16H328H320V24ZM448 56V96H408H368V56V16H408H448V56ZM32 56V80H56H80V56V32H56H32V56ZM176 40V48H168H160V40V32H168H176V40ZM384 56V80H408H432V56V32H408H384V56ZM288 72V80H280H272V72V64H280H288V72ZM208 88V96H216H224V104V112H232H240V96V80H248H256V96V112H264H272V104V96H280H288V120V144H296H304V160V176H296H288V184V192H304H320V200V208H328H336V192V176H328H320V168V160H328H336V168V176H344H352V200V224H344H336V240V256H344H352V248V240H360H368V248V256H360H352V288V320H328H304V328V336H312H320V352V368H312H304V384V400H312H320V408V416H336H352V408V400H360H368V408V416H376H384V424V432H376H368V440V448H360H352V440V432H336H320V440V448H312H304V440V432H296H288V424V416H280H272V424V432H264H256V424V416H264H272V392V368H264H256V360V352H248H240V336V320H248H256V328V336H264H272V320V304H280H288V288V272H280H272V264V256H256H240V264V272H248H256V288V304H248H240V296V288H216H192V296V304H208H224V312V320H200H176V328V336H192H208V344V352H200H192V360V368H200H208V384V400H192H176V392V384H184H192V376V368H176H160V360V352H152H144V344V336H152H160V328V320H152H144V312V304H136H128V288V272H120H112V280V288H104H96V280V272H104H112V264V256H96H80V272V288H72H64V272V256H72H80V248V240H96H112V232V224H104H96V216V208H104H112V200V192H104H96V184V176H80H64V168V160H80H96V152V144H112H128V152V160H112H96V168V176H120H144V184V192H136H128V200V208H136H144V216V224H160H176V216V208H168H160V200V192H176H192V176V160H184H176V168V176H168H160V168V160H168H176V152V144H184H192V152V160H200H208V152V144H216H224V128V112H216H208V120V128H192H176V112V96H184H192V88V80H200H208V88ZM160 104V112H152H144V104V96H152H160V104ZM192 104V112H200H208V104V96H200H192V104ZM240 136V144H248H256V160V176H248H240V168V160H224H208V168V176H216H224V184V192H208H192V200V208H200H208V216V224H224H240V232V240H248H256V232V224H248H240V208V192H256H272V184V176H280H288V160V144H280H272V136V128H256H240V136ZM416 136V144H424H432V152V160H416H400V176V192H408H416V184V176H424H432V168V160H440H448V168V176H456H464V152V128H456H448V136V144H440H432V136V128H424H416V136ZM448 200V208H440H432V216V224H440H448V232V240H456H464V216V192H456H448V200ZM112 216V224H120H128V216V208H120H112V216ZM304 216V224H288H272V232V240H280H288V256V272H296H304V288V304H296H288V312V320H296H304V312V304H312H320V296V288H328H336V272V256H328H320V264V272H312H304V256V240H312H320V224V208H312H304V216ZM176 232V240H184H192V232V224H184H176V232ZM128 248V256H136H144V248V240H136H128V248ZM208 248V256H200H192V264V272H208H224V256V240H216H208V248ZM48 264V272H40H32V264V256H40H48V264ZM160 272V288H152H144V296V304H152H160V296V288H168H176V272V256H168H160V272ZM384 296V304H376H368V296V288H376H384V296ZM0 328V336H16H32V328V320H16H0V328ZM48 328V336H56H64V328V320H56H48V328ZM384 360V384H360H336V360V336H360H384V360ZM0 408V464H56H112V408V352H56H0V408ZM272 360V368H280H288V360V352H280H272V360ZM352 360V368H360H368V360V352H360H352V360ZM96 408V448H56H16V408V368H56H96V408ZM32 408V432H56H80V408V384H56H32V408ZM192 456V464H216H240V456V448H216H192V456ZM448 456V464H456H464V456V448H456H448V456Z" fill="${color}"/></svg>`;
}

function getOverlaySvg(overlay: VisualOverlay) {
  const color = overlay.tone === "light" ? "#ffffff" : "#000000";

  if (overlay.asset === "star") {
    return `<svg width="456" height="457" viewBox="0 0 456 457" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M455.486 211.779V244.402V254.743C366.911 263.445 260.644 231.797 219.298 148.054C207.811 168.151 197.604 182.394 185.036 194.53C171.948 207.174 156.779 217.047 135.285 228.441C156.658 239.797 171.828 249.67 184.876 262.236C198.044 274.957 208.611 290.02 220.899 311.795C233.547 288.537 245.955 269.65 271.211 250.138C285.7 258.88 306.593 269.338 333.69 277.533L324.724 282.567C299.348 296.81 281.897 318.312 270.33 343.13C255.721 374.466 250.357 411.109 250.037 445.566L249.917 456.961H238.27H203.848H192.441L192.121 445.722C190.36 382.349 176.551 336.458 147.693 306.137C118.995 275.894 74.4868 260.284 11.2471 257.162L0 256.616V245.729V245.651V211.349V211.232V200.345L11.2471 199.798C76.6482 196.599 121.116 180.17 149.294 149.615C177.632 118.864 190.4 73.0123 192.121 11.2387L192.441 0H203.848H238.27H249.917L250.037 11.3948C251.198 140.327 326.365 213.808 455.486 198.901V211.818V211.779Z" fill="${color}"/></svg>`;
  }

  if (overlay.asset === "logo") {
    return `<svg width="1447" height="266" viewBox="0 0 1447 266" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M556.717 129.646C556.717 197.115 509.824 242.834 440.622 242.834C371.42 242.834 324.527 197.138 324.527 129.646C324.527 62.1536 371.42 16.4573 440.645 16.4573C509.87 16.4573 556.74 62.1762 556.74 129.646H556.717ZM361.531 129.646C361.531 181.272 394.379 211.419 440.622 211.419C486.865 211.419 520.038 181.249 520.038 129.646C520.038 78.042 487.19 47.5552 440.622 47.5552C394.054 47.5552 361.531 78.0194 361.531 129.646Z" fill="${color}"/><path d="M697.378 82.7037H730.877V238.171H697.378V219.204C685.585 233.508 668.035 242.833 643.8 242.833C600.11 242.833 572.996 212.052 572.996 170.701V82.7037H606.494V171.312C606.494 196.82 619.889 213.297 646.678 213.297C676.021 213.297 697.402 193.719 697.402 160.449V82.7037H697.378Z" fill="${color}"/><path d="M817.271 213.906V243.442C778.363 245.615 753.176 228.527 753.176 187.788V20.5061H786.674V82.7019H817.294V112.238H786.674V189.032C786.674 212.05 800.695 213.906 817.294 213.906H817.271Z" fill="${color}"/><path d="M961.115 177.832H994.289C989.506 217.326 955.706 242.811 911.367 242.811C860.969 242.811 826.844 209.541 826.844 160.404C826.844 111.268 860.969 77.9968 911.367 77.9968C955.381 77.9968 989.181 103.188 994.289 142.365H960.79C955.056 120.276 936.23 107.533 911.367 107.533C880.422 107.533 858.74 127.133 858.74 160.404C858.74 193.675 880.422 213.252 911.367 213.252C936.555 213.252 955.381 200.51 961.115 177.809V177.832Z" fill="${color}"/><path d="M1013.41 238.173V82.7064H1046.91V94.204C1060.31 79.583 1079.76 73.9926 1104.65 80.2167L1098.91 108.191C1062.56 102.284 1046.94 122.812 1046.94 160.429V238.173H1013.44H1013.41Z" fill="${color}"/><path d="M1235.38 220.744C1223.27 234.12 1205.09 242.811 1180.53 242.811C1132.36 242.811 1098.23 209.541 1098.23 160.404C1098.23 111.268 1132.36 77.9968 1180.53 77.9968C1205.09 77.9968 1223.27 86.7106 1235.38 100.064V82.6593H1268.88V238.126H1235.38V220.721V220.744ZM1182.76 213.298C1214 213.298 1235.38 193.72 1235.38 160.449C1235.38 127.179 1214.03 107.578 1182.76 107.578C1151.49 107.578 1130.13 127.179 1130.13 160.449C1130.13 193.72 1151.81 213.298 1182.76 213.298Z" fill="${color}"/><path d="M1344.77 46.3104C1335.53 46.3104 1324.69 50.0448 1324.69 67.7666V86.7331H1355.31V116.269H1324.69V238.149H1291.19V68.0834C1291.19 39.792 1308.42 16.4573 1339.66 16.4573C1346.05 16.4573 1359.44 17.3852 1371.24 22.9983L1358.79 48.4832C1353.69 46.9215 1348.58 46.3104 1344.77 46.3104Z" fill="${color}"/><path d="M1446.52 213.906V243.442C1407.61 245.615 1382.42 228.527 1382.42 187.788V20.5061H1415.92V82.7019H1446.54V112.238H1415.92V189.032C1415.92 212.05 1429.94 213.906 1446.54 213.906H1446.52Z" fill="${color}"/><path d="M264.179 122.83V141.751V147.749C212.805 152.796 151.171 134.441 127.191 85.8701C120.529 97.5262 114.609 105.787 107.32 112.826C99.7286 120.159 90.9304 125.885 78.4643 132.494C90.8608 139.081 99.659 144.807 107.227 152.095C114.864 159.473 120.993 168.209 128.12 180.839C135.455 167.349 142.652 156.395 157.3 145.078C165.704 150.148 177.822 156.214 193.538 160.967L188.338 163.887C173.62 172.148 163.498 184.618 156.789 199.013C148.316 217.188 145.205 238.44 145.02 258.425L144.95 265.034H138.195H118.23H111.614L111.429 258.516C110.407 221.759 102.398 195.143 85.6608 177.557C69.0161 160.016 43.2018 150.963 6.52322 149.152L0 148.835V142.521V142.476V122.581V122.513V116.198L6.52322 115.882C44.4554 114.026 70.2465 104.497 86.5893 86.7754C103.025 68.9405 110.43 42.3466 111.429 6.51834L111.614 0H118.23H138.195H144.95L145.02 6.60887C145.693 81.3887 189.289 124.007 264.179 115.361V122.853V122.83Z" fill="${color}"/></svg>`;
  }

  if (overlay.asset === "waveform") {
    return getWaveformSvg(color);
  }

  return null;
}

function getWaveformSvg(color: string) {
  const heights = [
    42, 28, 76, 36, 64, 30, 58, 84, 96, 54, 62, 74, 48, 40, 58, 70,
    36, 50, 44, 78, 92, 52, 66, 88, 100, 62, 48, 56, 74, 34, 58, 108,
    116, 80, 98, 64, 42, 38, 46, 54, 110, 68, 44, 40, 72, 52, 88, 62,
    76, 82, 90, 58, 46, 70, 78, 52, 64, 42, 74, 50, 38, 54, 44, 60,
  ];
  const bars = heights
    .map((height, index) => {
      const x = 8 + index * 15;
      const y = 72 - height / 2;

      return `<rect x="${x}" y="${y}" width="5" height="${height}" rx="2.5" fill="${color}"/>`;
    })
    .join("");

  return `<svg width="970" height="144" viewBox="0 0 970 144" fill="none" xmlns="http://www.w3.org/2000/svg">${bars}</svg>`;
}

function generateVisualName() {
  const modifiers = [
    "Velvet",
    "Nocturne",
    "Signal",
    "Ghost",
    "Orbit",
    "Static",
    "Halo",
    "Drift",
  ];
  const nouns = [
    "Mesh",
    "Bloom",
    "Field",
    "Pulse",
    "Trace",
    "Echo",
    "Gradient",
    "Frame",
  ];
  const modifier = modifiers[Math.floor(Math.random() * modifiers.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const suffix = Math.floor(100 + Math.random() * 900);

  return `${modifier} ${noun} ${suffix}`;
}

function downloadDataUrl(dataUrl: string, filename: string) {
  const link = document.createElement("a");

  link.download = filename;
  link.href = dataUrl;
  link.click();
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.download = filename;
  link.href = url;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function getSupportedVideoMimeType(videoFormat: VideoExportFormat) {
  const mimeTypes =
    videoFormat === "mp4"
      ? ["video/mp4;codecs=h264", "video/mp4;codecs=avc1.42E01E", "video/mp4"]
      : ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];

  return mimeTypes.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? "";
}

function getCompressedVideoBitrate(
  formatToExport: FormatConfig,
  preset: VideoBitratePreset,
) {
  const exportWidth = formatToExport.exportWidth ?? 1080;
  const exportHeight = formatToExport.exportHeight ?? 1080;
  const megapixels = (exportWidth * exportHeight) / 1_000_000;
  const presetConfig = {
    low: { max: 2_800_000, min: 1_200_000, rate: 1_150_000 },
    standard: { max: 4_200_000, min: 1_800_000, rate: 1_750_000 },
    high: { max: 8_000_000, min: 2_400_000, rate: 2_650_000 },
  } satisfies Record<VideoBitratePreset, { max: number; min: number; rate: number }>;
  const { max, min, rate } = presetConfig[preset];
  const bitrate = megapixels * rate;

  return Math.round(Math.max(min, Math.min(max, bitrate)));
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function readGalleryState(): Promise<GalleryState> {
  const response = await fetch(galleryApiPath, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error("Gallery file could not be loaded.");
  }

  return normalizeGalleryState(await response.json());
}

async function writeGalleryState(state: GalleryState): Promise<void> {
  const response = await fetch(galleryApiPath, {
    body: JSON.stringify(state),
    headers: { "Content-Type": "application/json" },
    method: "PUT",
  });

  if (!response.ok) {
    throw new Error("Gallery file could not be saved.");
  }
}

function readLegacyGalleryState(): GalleryState | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const storedState = window.localStorage.getItem(legacyGalleryStorageKey);

    if (!storedState) {
      return null;
    }

    const galleryState = normalizeGalleryState(JSON.parse(storedState));

    return hasGalleryContent(galleryState) ? galleryState : null;
  } catch {
    return null;
  }
}

function mergeGalleryStates(
  fileGalleryState: GalleryState,
  legacyGalleryState: GalleryState,
): GalleryState {
  const sections = [...fileGalleryState.sections];
  const sectionIds = new Set(sections.map((section) => section.id));

  legacyGalleryState.sections.forEach((section) => {
    if (!sectionIds.has(section.id)) {
      sections.push(section);
      sectionIds.add(section.id);
    }
  });

  const visualIds = new Set(fileGalleryState.items.map((item) => item.id));
  const items = [
    ...fileGalleryState.items,
    ...legacyGalleryState.items.filter((item) => {
      if (visualIds.has(item.id)) {
        return false;
      }

      visualIds.add(item.id);
      return true;
    }),
  ];

  return normalizeGalleryState({ items, sections });
}

function hasGalleryContent(state: GalleryState) {
  return (
    state.items.length > 0 ||
    state.sections.some((section) => section.id !== defaultGallerySection.id)
  );
}

function readStoredTheme(): UiTheme {
  if (typeof window === "undefined") {
    return "light";
  }

  try {
    return window.localStorage.getItem(themeStorageKey) === "dark"
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
}

function writeStoredTheme(theme: UiTheme) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(themeStorageKey, theme);
  } catch {
    // Theme persistence is optional; the UI still works if storage is blocked.
  }
}

function normalizeGalleryState(value: unknown): GalleryState {
  const rawItems = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.items)
      ? value.items
      : [];
  const rawSections =
    isRecord(value) && Array.isArray(value.sections) ? value.sections : [];
  const normalizedSections = rawSections
    .map(normalizeGallerySection)
    .filter((section): section is GallerySection => section !== null);
  const sections =
    normalizedSections.length > 0
      ? ensureDefaultSection(normalizedSections)
      : [{ ...defaultGallerySection }];
  const sectionIds = new Set(sections.map((section) => section.id));
  const fallbackSectionId = sections[0]?.id ?? defaultGallerySection.id;
  const items = rawItems
    .map((item) => normalizeGalleryItem(item, sectionIds, fallbackSectionId))
    .filter((item): item is VisualSnapshot => item !== null);

  return { items, sections };
}

function createDefaultGalleryState(): GalleryState {
  return {
    items: [],
    sections: [{ ...defaultGallerySection }],
  };
}

function normalizeGallerySection(value: unknown): GallerySection | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = typeof value.id === "string" && value.id ? value.id : "";
  const name = typeof value.name === "string" && value.name.trim()
    ? value.name.trim()
    : "";

  if (!id || !name) {
    return null;
  }

  return {
    id,
    isOpen: typeof value.isOpen === "boolean" ? value.isOpen : true,
    name,
  };
}

function normalizeGalleryItem(
  value: unknown,
  sectionIds: Set<string>,
  fallbackSectionId: string,
): VisualSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  const sectionId =
    typeof value.sectionId === "string" && sectionIds.has(value.sectionId)
      ? value.sectionId
      : fallbackSectionId;

  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.thumbnail !== "string" ||
    typeof value.backgroundColor !== "string" ||
    !Array.isArray(value.blobs) ||
    !isRecord(value.format) ||
    !isRecord(value.mesh)
  ) {
    return null;
  }

  return {
    backgroundColor: value.backgroundColor,
    blobs: (value.blobs as BlobConfig[]).map((blob, index) =>
      normalizeBlob(blob, index),
    ),
    format: value.format as FormatConfig,
    id: value.id,
    mesh: normalizeMesh(value.mesh as MeshConfig),
    name: value.name,
    overlay: normalizeOverlay(value.overlay),
    sectionId,
    thumbnail: value.thumbnail,
  };
}

function normalizeOverlay(value: unknown): VisualOverlay {
  if (!isRecord(value)) {
    return { ...defaultVisualOverlay };
  }

  const asset = "waveform";
  const tone =
    value.tone === "light" || value.tone === "dark"
      ? value.tone
      : defaultVisualOverlay.tone;
  const bottomRight =
    value.bottomRight === "button" ||
    value.bottomRight === "qr" ||
    value.bottomRight === "slogan"
      ? value.bottomRight
      : defaultVisualOverlay.bottomRight;
  const showTopLogo =
    typeof value.showTopLogo === "boolean"
      ? value.showTopLogo
      : defaultVisualOverlay.showTopLogo;
  const showBottomLeftSlogan =
    typeof value.showBottomLeftSlogan === "boolean"
      ? value.showBottomLeftSlogan
      : typeof value.showBottomCta === "boolean"
        ? value.showBottomCta
        : defaultVisualOverlay.showBottomLeftSlogan;
  const showBottomCta =
    typeof value.showBottomCta === "boolean"
      ? value.showBottomCta
      : defaultVisualOverlay.showBottomCta;
  return { asset, bottomRight, showBottomCta, showBottomLeftSlogan, showTopLogo, tone };
}

function ensureDefaultSection(sections: GallerySection[]) {
  if (sections.some((section) => section.id === defaultGallerySection.id)) {
    return sections;
  }

  return [{ ...defaultGallerySection }, ...sections];
}

function getExistingSectionId(sections: GallerySection[], sectionId: string) {
  return (
    sections.find((section) => section.id === sectionId)?.id ??
    sections[0]?.id ??
    defaultGallerySection.id
  );
}

function findDefaultAmbientVisual(items: VisualSnapshot[]) {
  const byName = items.find((item) =>
    item.name.trim().toLowerCase() === "static mesh 670",
  );

  if (byName) {
    return byName;
  }

  return items.find((item) => Math.round(item.mesh.frame) === 670) ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finiteNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function getWaveformStyle() {
  return {
    bellBoost: 1.2,
    centerEnvelopePower: 3,
    centerGain: 1.5,
    edgeGain: 1,
    noiseFloor: 0.02,
    sideFloor: 0.06,
    sideMotionMix: 0.05,
    useStarProfile: false,
    verticalGain: 1.0,
    widthFactor: 1,
  };
}

function sampleSpectrumLevels(
  levels: Uint8Array,
  sampleRate: number,
  bandCount: number,
  minFrequency: number,
  maxFrequency: number,
) {
  const nyquist = sampleRate / 2;
  const clampedMaxFrequency = Math.min(maxFrequency, nyquist);
  const clampedMinFrequency = Math.max(1, Math.min(minFrequency, clampedMaxFrequency));

  return Array.from({ length: bandCount }, (_, index) => {
    const startFrequency = frequencyAtBand(
      index / bandCount,
      clampedMinFrequency,
      clampedMaxFrequency,
    );
    const endFrequency = frequencyAtBand(
      (index + 1) / bandCount,
      clampedMinFrequency,
      clampedMaxFrequency,
    );
    const startIndex = frequencyToIndex(startFrequency, nyquist, levels.length);
    const endIndex = Math.max(
      startIndex + 1,
      frequencyToIndex(endFrequency, nyquist, levels.length),
    );
    let total = 0;

    for (let frequencyIndex = startIndex; frequencyIndex < endIndex; frequencyIndex++) {
      total += levels[frequencyIndex] ?? 0;
    }

    const average = total / Math.max(1, endIndex - startIndex) / 255;
    return Math.max(0, Math.min(1, average * 1.9));
  });
}

function frequencyAtBand(progress: number, minFrequency: number, maxFrequency: number) {
  const minLog = Math.log10(minFrequency);
  const maxLog = Math.log10(maxFrequency);
  return 10 ** (minLog + (maxLog - minLog) * progress);
}

function frequencyToIndex(frequency: number, nyquist: number, levelCount: number) {
  const normalized = Math.max(0, Math.min(1, frequency / nyquist));
  return Math.max(0, Math.min(levelCount - 1, Math.floor(normalized * levelCount)));
}

function connectMonoOutput(audioContext: AudioContext, source: AudioNode) {
  const splitter = audioContext.createChannelSplitter(2);
  const leftGain = audioContext.createGain();
  const rightGain = audioContext.createGain();
  const merger = audioContext.createChannelMerger(1);

  leftGain.gain.value = 0.5;
  rightGain.gain.value = 0.5;
  source.connect(splitter);
  splitter.connect(leftGain, 0);
  splitter.connect(rightGain, 1);
  leftGain.connect(merger, 0, 0);
  rightGain.connect(merger, 0, 0);
  merger.connect(audioContext.destination);
}

function rotateRight(values: number[], steps: number) {
  if (values.length === 0) {
    return values;
  }

  const normalizedSteps = ((steps % values.length) + values.length) % values.length;

  if (normalizedSteps === 0) {
    return values;
  }

  return [
    ...values.slice(values.length - normalizedSteps),
    ...values.slice(0, values.length - normalizedSteps),
  ];
}

export default App;
