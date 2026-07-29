import { ShaderStage, type ShaderStageHandle } from "./components/ShaderStage";
import { Button } from "./components/ui/button";
import { Slider } from "./components/ui/slider";
import { loadAudioBuffer } from "./export/loadAudioBuffer";
import { prepareVideoOutputDestination } from "./export/outputDestination";
import {
  fixedGrainMixer,
  fixedGrainOverlay,
  initialBackgroundColor,
  initialBlobs,
  initialMesh,
  paletteGroups,
  presetAudioReactivity,
  presetAudioSmoothness,
} from "./data/palette";
import { ShaderClock } from "./lib/ShaderClock";
import { ShaderRenderer } from "./lib/ShaderRenderer";
import { getAudioEnvelope } from "./lib/audioEnvelope";
import {
  configureLiveAudioAnalyser,
  createLiveAudioSpectrumState,
  updateLiveAudioSpectrum,
  type LiveAudioSpectrumState,
} from "./lib/audioSpectrum";
import {
  createWaveformBars,
  getWaveformBarGlowOpacity,
  getWaveformBarLayerOpacities,
  getWaveformStyle,
  WAVEFORM_AMPLITUDE_SCALE,
  WAVEFORM_EDGE_BLUR_MAX_RATIO,
  WAVEFORM_GLOW_BLUR_MAX_RATIO,
  type WaveformStyle,
} from "./lib/waveformBars";
import {
  getWaveformAmplitudeScale,
  getWaveformBarCount,
  getWaveformBarOffset,
  getWaveformGeometry,
  getWaveformGlowHeight,
  getWaveformMaxPeakHeight,
  getWaveformRenderedBarHeight,
  getWaveformRenderedBarCenterOffset,
  getWaveformRenderedBarOpacityScale,
  getWaveformRenderedBarWidth,
} from "./lib/waveformGeometry";
import {
  getSceneHorizontalPadding,
} from "./lib/sceneGeometry";
import { cn } from "./lib/utils";
import type {
  BlobConfig,
  BottomRightOverlay,
  CenterLogoSize,
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
  ChevronDown,
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
  VolumeX,
} from "lucide-react";
import {
  Children,
  type ChangeEvent,
  type CSSProperties,
  type ReactElement,
  type FormEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  isValidElement,
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
const allExportFormatLabels = singleFormatOptions.map((option) => option.label);
const meshFrameMax = 500000;
const timelineScrubCenter = meshFrameMax / 2;
const videoPreparationProgressWeight = 0.08;
const microphoneCaptureProgressWeight = 0.06;
const videoFormatMaxAttempts = 2;
const videoFormatStallTimeoutMs = 90_000;
const videoEncoderRecoveryDelayMs = 400;
const defaultVisualOverlay: VisualOverlay = {
  asset: "waveform",
  bottomRight: "button",
  centerLogoOnly: false,
  centerLogoSize: "33",
  showBottomLeftSlogan: true,
  showBottomCta: false,
  showTopLogo: true,
  tone: "light",
};

type FormatOption = (typeof formatOptions)[number];
type SingleFormatOption = (typeof singleFormatOptions)[number];
type ActiveTab = "generate" | "gallery";
type AutoRandomizeInterval = "5" | "10" | "15" | "random";
type VideoDuration = 15 | 30 | 60 | 120 | 240;
type VideoExportFormat = "webm" | "mp4";
type VideoBitratePreset = "low" | "standard" | "high";
type VideoFrameRate = 30 | 60;
type VideoExportOptions = {
  audioSource: VideoAudioSource;
  bitratePreset: VideoBitratePreset;
  durationSeconds: number;
  frameRate: VideoFrameRate;
  isLoopable: boolean;
};
type VideoExportProgress = {
  attempt: number;
  completedFormats: number;
  formatLabel: string;
  formatIndex: number;
  maxAttempts: number;
  overallProgress: number;
  progress: number;
  totalFormats: number;
};
type VideoExportNotice = {
  kind: "error" | "success";
  message: string;
};
type CompletedVideoExportFormat = {
  filename: string;
  formatLabel: string;
  sizeBytes: number;
};
type FailedVideoExportFormat = {
  formatLabel: string;
  reason: string;
};
type GallerySaveStatus = "loading" | "saving" | "saved" | "error";
type MusicStatus = "idle" | "loading" | "playing";
type MicStatus = "idle" | "loading" | "listening";
type VoiceStatus = "idle" | "loading" | "playing";
type VideoAudioSource = "none" | "microphone" | "file";
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
type GalleryDocument = {
  revision: string | null;
  state: GalleryState;
};
type GalleryWriteResult = {
  revision: string | null;
  state: GalleryState;
};
const galleryApiPath = "/api/gallery";
const staticGalleryPath = "data/gallery.json";
const legacyGalleryStorageKey = "outcraft.gallery.v1";
const galleryConflictRetryLimit = 4;
const themeStorageKey = "outcraft.ui-theme.v1";
const sampleAudioPath =
  "/audio/019e083a-6191-7000-b905-5d72c6a03184-1778254690727-af155e06-25ca-4c6b-89ce-577ba10962fd-stereo.mp3";
const autoRandomizeIntervals = [5, 10, 15] as const;
const blurredBackdropCache = new WeakMap<
  CanvasRenderingContext2D,
  {
    canvas: HTMLCanvasElement;
    context: CanvasRenderingContext2D;
  }
>();
const waveformBlurLayerCache = new WeakMap<
  CanvasRenderingContext2D,
  {
    canvas: HTMLCanvasElement;
    context: CanvasRenderingContext2D;
  }
>();
const waveformGlowLayerCache = new WeakMap<
  CanvasRenderingContext2D,
  {
    canvas: HTMLCanvasElement;
    color: string;
    context: CanvasRenderingContext2D;
    sprite: HTMLCanvasElement;
  }
>();
const defaultGallerySection: GallerySection = {
  id: "favorites",
  isOpen: true,
  name: "Favorites",
};

function App() {
  const [shaderClock] = useState(
    () => new ShaderClock(normalizeMesh(initialMesh).frame),
  );
  const stageRef = useRef<ShaderStageHandle | null>(null);
  const formatStageRefs = useRef<Record<string, ShaderStageHandle | null>>({});
  const voiceAudioRef = useRef<HTMLAudioElement | null>(null);
  const musicAudioRef = useRef<HTMLAudioElement | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const musicAnalyserRef = useRef<AnalyserNode | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const voiceAnalyserRef = useRef<AnalyserNode | null>(null);
  const musicSpectrumStateRef = useRef<LiveAudioSpectrumState | null>(null);
  const micSpectrumStateRef = useRef<LiveAudioSpectrumState | null>(null);
  const voiceSpectrumStateRef = useRef<LiveAudioSpectrumState | null>(null);
  const audioSmoothnessRef = useRef(normalizeMesh(initialMesh).audioSmoothness);
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
  const galleryBaseStateRef = useRef<GalleryState>(createDefaultGalleryState());
  const pendingGalleryStateRef = useRef<GalleryState | null>(null);
  const galleryRevisionRef = useRef<string | null>(null);
  const galleryStateRef = useRef<GalleryState>(createDefaultGalleryState());
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
  galleryStateRef.current = galleryState;
  const [gallerySaveStatus, setGallerySaveStatus] =
    useState<GallerySaveStatus>("loading");
  const [audioBands, setAudioBands] = useState<number[]>(() => Array(8).fill(0));
  const [audioSpectrum, setAudioSpectrum] = useState<number[]>(() => Array(64).fill(0));
  const [audioLevel, setAudioLevel] = useState(0);
  const [musicStatus, setMusicStatus] = useState<MusicStatus>("idle");
  const [micStatus, setMicStatus] = useState<MicStatus>("idle");
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("idle");
  const [videoAudioSource, setVideoAudioSource] =
    useState<VideoAudioSource>("none");
  const [audioDurationSeconds, setAudioDurationSeconds] = useState<number | null>(null);
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
  const [autoRandomizeColors, setAutoRandomizeColors] = useState(false);
  const [autoRandomizeWaveform, setAutoRandomizeWaveform] = useState(false);
  const [colorRandomizeInterval, setColorRandomizeInterval] =
    useState<AutoRandomizeInterval>("10");
  const [waveformRandomizeInterval, setWaveformRandomizeInterval] =
    useState<AutoRandomizeInterval>("10");
  const [waveformStyle, setWaveformStyle] =
    useState<WaveformStyle>(() => getWaveformStyle());
  const [selectedVisualId, setSelectedVisualId] = useState<string | null>(null);
  const [exportFormats, setExportFormats] = useState<Set<string>>(
    () => new Set(allExportFormatLabels),
  );
  const [audioSource, setAudioSource] = useState(sampleAudioPath);
  const [audioFileName, setAudioFileName] = useState("Default MP3");
  const [videoExportProgress, setVideoExportProgress] =
    useState<VideoExportProgress | null>(null);
  const [videoExportNotice, setVideoExportNotice] =
    useState<VideoExportNotice | null>(null);
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
  const videoExportAbortRef = useRef<AbortController | null>(null);
  const isExportingVideoRef = useRef(false);
  const videoExportLaunchPendingRef = useRef(false);
  const audioPreviewSessionRef = useRef(0);

  useEffect(() => {
    audioSmoothnessRef.current = mesh.audioSmoothness;
  }, [mesh.audioSmoothness]);

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
  const previewGridStyle = {
    "--preview-grid-pan-x": `${previewPan.x * 0.5}px`,
    "--preview-grid-pan-y": `${previewPan.y * 0.5}px`,
  } as CSSProperties;
  const secondaryPreviewFormats = visiblePreviewFormats.filter(
    (option) => option.label !== primaryPreviewFormat.label,
  );
  const previewFormatSplitIndex = Math.ceil(secondaryPreviewFormats.length / 2);
  const leftPreviewFormats = secondaryPreviewFormats.slice(
    0,
    previewFormatSplitIndex,
  );
  const rightPreviewFormats = secondaryPreviewFormats.slice(
    previewFormatSplitIndex,
  );
  const recordingProgress = videoExportProgress
    ? Math.max(0, Math.min(1, videoExportProgress.overallProgress))
    : 0;
  const recordingProgressPercent = Math.round(recordingProgress * 100);
  const recordingProgressStyle = {
    "--recording-progress": recordingProgress.toFixed(4),
  } as CSSProperties;
  const effectiveVideoDurationSeconds =
    videoAudioSource === "file" && audioDurationSeconds
      ? audioDurationSeconds
      : videoDuration;
  const videoAudioStatusLabel =
    videoAudioSource === "file"
      ? audioDurationSeconds
        ? `Audio · ${formatMediaDurationLabel(audioDurationSeconds)}`
        : "Audio"
      : videoAudioSource === "microphone"
        ? `Mic · ${formatMediaDurationLabel(videoDuration)}`
        : "No audio";

  const updatePreviewZoom = (delta: number) => {
    setPreviewZoom((currentZoom) =>
      Math.max(0.45, Math.min(2.5, Number((currentZoom + delta).toFixed(2)))),
    );
  };

  const cancelVideoExport = () => {
    videoExportAbortRef.current?.abort(
      new DOMException("Video export cancelled.", "AbortError"),
    );
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
    musicSpectrumStateRef.current = null;
    micSpectrumStateRef.current = null;
    voiceSpectrumStateRef.current = null;
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
    if (isExportingVideo) {
      event.currentTarget.value = "";
      return;
    }

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
    setVideoAudioSource("file");
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

  const activatePresetPreviewDefaults = useCallback(() => {
    setFormat(singleFormatOptions[0]);
    setExportFormats(new Set(allExportFormatLabels));
    setPreviewPan({ x: 0, y: 0 });
  }, []);

  const flushGallerySaveQueue = async () => {
    if (isSavingGalleryRef.current) {
      return;
    }

    isSavingGalleryRef.current = true;
    let failedGalleryState: GalleryState | null = null;

    try {
      while (pendingGalleryStateRef.current) {
        const nextGalleryState = pendingGalleryStateRef.current;
        pendingGalleryStateRef.current = null;
        failedGalleryState = nextGalleryState;

        const savedGallery = await writeGalleryState(
          nextGalleryState,
          galleryRevisionRef.current,
          galleryBaseStateRef.current,
        );
        galleryRevisionRef.current = savedGallery.revision;
        galleryBaseStateRef.current = savedGallery.state;
        failedGalleryState = null;

        const newerLocalState =
          pendingGalleryStateRef.current ??
          (galleryStateRef.current !== nextGalleryState
            ? galleryStateRef.current
            : null);

        if (newerLocalState) {
          const rebasedGalleryState = mergeConcurrentGalleryStates(
            nextGalleryState,
            newerLocalState,
            savedGallery.state,
          );

          pendingGalleryStateRef.current = rebasedGalleryState;
          galleryStateRef.current = rebasedGalleryState;
          skipNextGallerySaveRef.current = true;
          setGalleryState(rebasedGalleryState);
        } else if (savedGallery.state !== nextGalleryState) {
          galleryStateRef.current = savedGallery.state;
          skipNextGallerySaveRef.current = true;
          setGalleryState(savedGallery.state);
        }
      }

      setGallerySaveStatus("saved");
    } catch {
      pendingGalleryStateRef.current ??= failedGalleryState;
      setGallerySaveStatus("error");
    } finally {
      isSavingGalleryRef.current = false;

      if (!failedGalleryState && pendingGalleryStateRef.current) {
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
    activatePresetPreviewDefaults();
    setVisualOverlay((currentOverlay) => ({
      ...currentOverlay,
      asset: "waveform",
      bottomRight: "button",
      centerLogoOnly: false,
      centerLogoSize: "33",
      showBottomLeftSlogan: true,
      showBottomCta: true,
      showTopLogo: true,
    }));

    if (!defaultAmbientVisual) {
      return;
    }

    const normalizedMesh = applyPresetAudioDefaults(
      normalizeRenderMesh(defaultAmbientVisual.mesh),
    );
    setBackgroundColor(defaultAmbientVisual.backgroundColor);
    setBlobs(cloneBlobs(defaultAmbientVisual.blobs));
    grainMixerRef.current = normalizedMesh.grainMixer;
    setMesh(normalizedMesh);
    setTimelineFrame(
      isPaused ? timelineScrubCenter : clampFrame(normalizedMesh.frame),
    );
    setPausedFrame(normalizedMesh.frame);
    setFrameOffset(0);
    setSelectedVisualId(defaultAmbientVisual.id);
  };

  useEffect(() => {
    writeStoredTheme(uiTheme);
  }, [uiTheme]);

  useEffect(() => {
    const audio = new Audio();
    let isCurrentSource = true;

    const updateDuration = () => {
      if (!isCurrentSource) {
        return;
      }

      setAudioDurationSeconds(
        Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null,
      );
    };
    const clearDuration = () => {
      if (isCurrentSource) {
        setAudioDurationSeconds(null);
      }
    };

    setAudioDurationSeconds(null);
    setAudioElementSource(audio, audioSource);
    audio.preload = "metadata";
    audio.addEventListener("loadedmetadata", updateDuration);
    audio.addEventListener("durationchange", updateDuration);
    audio.addEventListener("error", clearDuration);
    audio.load();

    return () => {
      isCurrentSource = false;
      audio.removeEventListener("loadedmetadata", updateDuration);
      audio.removeEventListener("durationchange", updateDuration);
      audio.removeEventListener("error", clearDuration);
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    };
  }, [audioSource]);

  useEffect(() => {
    let isMounted = true;

    const loadGalleryState = async () => {
      try {
        const galleryDocument = await readGalleryState();
        const fileGalleryState = galleryDocument.state;
        const legacyGalleryState = readLegacyGalleryState();
        const nextGalleryState = legacyGalleryState
          ? mergeGalleryStates(fileGalleryState, legacyGalleryState)
          : fileGalleryState;

        if (!isMounted) {
          return;
        }

        galleryRevisionRef.current = galleryDocument.revision;
        galleryBaseStateRef.current = fileGalleryState;
        galleryStateRef.current = nextGalleryState;
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
        galleryRevisionRef.current = null;
        galleryBaseStateRef.current = fallbackGalleryState;
        galleryStateRef.current = fallbackGalleryState;
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
      audioPreviewSessionRef.current += 1;
      videoExportAbortRef.current?.abort(
        new DOMException("Application closed during video export.", "AbortError"),
      );
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
      setTimelineFrame(isPaused ? timelineScrubCenter : nextFrame);
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

  const randomizeComposition = useCallback(() => {
    const nextFrame = randomBetween(0, meshFrameMax);
    activatePresetPreviewDefaults();
    setTimelineFrame(isPaused ? timelineScrubCenter : nextFrame);
    setPausedFrame(nextFrame);
    setFrameOffset(0);
    setMesh((currentMesh) => ({
      ...currentMesh,
      audioReactivity: presetAudioReactivity,
      audioSmoothness: presetAudioSmoothness,
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
  }, [activatePresetPreviewDefaults, isPaused]);

  const randomizeColors = useCallback(() => {
    setBackgroundColor(randomPaletteColor(activePaletteId));
    setBlobs((currentBlobs) =>
      currentBlobs.map((blob) => ({
        ...blob,
        color: randomPaletteColor(activePaletteId),
      })),
    );
  }, [activePaletteId]);

  const randomizeWaveform = useCallback(() => {
    setWaveformStyle(createRandomWaveformStyle());
    setMesh((currentMesh) => ({
      ...currentMesh,
      audioReactivity: presetAudioReactivity,
      audioSmoothness: presetAudioSmoothness,
      distortion: randomBetween(0.12, 1.15),
      grainMixer: grainMixerRef.current,
      grainOverlay: fixedGrainOverlay,
      motionBlur: randomBetween(0, 0.7),
      scale: randomBetween(0.7, 2.4),
      swirl: randomBetween(0, 0.6),
    }));
  }, []);

  useEffect(() => {
    if (!autoRandomizeColors || isExportingVideo) {
      return;
    }

    let timeoutId = 0;
    const scheduleNextRandomize = () => {
      timeoutId = window.setTimeout(() => {
        randomizeColors();
        scheduleNextRandomize();
      }, getAutoRandomizeDelayMs(colorRandomizeInterval));
    };

    scheduleNextRandomize();

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    autoRandomizeColors,
    colorRandomizeInterval,
    isExportingVideo,
    randomizeColors,
  ]);

  useEffect(() => {
    if (!autoRandomizeWaveform || isExportingVideo) {
      return;
    }

    let timeoutId = 0;
    const scheduleNextRandomize = () => {
      timeoutId = window.setTimeout(() => {
        randomizeWaveform();
        scheduleNextRandomize();
      }, getAutoRandomizeDelayMs(waveformRandomizeInterval));
    };

    scheduleNextRandomize();

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    autoRandomizeWaveform,
    isExportingVideo,
    randomizeWaveform,
    waveformRandomizeInterval,
  ]);

  useEffect(() => {
    if (videoAudioSource !== "none" && isVideoLoopEnabled) {
      // Arbitrary uploaded/live audio cannot be made sample-perfectly loopable
      // by fading video alone, so never advertise a false A/V loop.
      setIsVideoLoopEnabled(false);
    }
  }, [isVideoLoopEnabled, videoAudioSource]);

  const togglePlayback = () => {
    const currentMesh = normalizeRenderMesh(
      stageRef.current?.getCurrentMesh() ?? mesh,
    );

    setMesh(currentMesh);
    setPausedFrame(currentMesh.frame);
    setFrameOffset(0);
    setTimelineFrame(
      isPaused ? clampFrame(currentMesh.frame) : timelineScrubCenter,
    );
    setIsPaused(!isPaused);
  };

  const scrubTimelineFrame = (nextValue: number) => {
    const nextTimelineFrame = clampFrame(nextValue);
    let anchorFrame = pausedFrame;
    let nextOffset = nextTimelineFrame - timelineScrubCenter;

    if (!isPaused) {
      const currentMesh = normalizeRenderMesh(
        stageRef.current?.getCurrentMesh() ?? mesh,
      );
      anchorFrame = currentMesh.frame;
      nextOffset = nextTimelineFrame - timelineFrame;
      setPausedFrame(anchorFrame);
    }

    const nextRenderFrame = anchorFrame + nextOffset;
    setFrameOffset(nextOffset);
    setIsPaused(true);
    setTimelineFrame(nextTimelineFrame);
    setMesh((currentMesh) =>
      normalizeRenderMesh({
        ...currentMesh,
        frame: nextRenderFrame,
      }),
    );
  };

  const captureCurrentVisual = () => {
    const currentMesh = applyPresetAudioDefaults(
      normalizeRenderMesh(stageRef.current?.getCurrentMesh() ?? mesh),
    );
    const thumbnail = stageRef.current?.captureThumbnail(
      undefined,
      currentMesh.frame,
    );

    if (!thumbnail) {
      return null;
    }

    return {
      backgroundColor,
      blobs: cloneBlobs(blobs),
      format: cloneFormat(format),
      mesh: currentMesh,
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
      renderVersion: 2,
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

  const getWaveformPreviewTimestampSeconds = () => {
    if (voiceStatus === "playing") {
      return voiceAudioRef.current?.currentTime ?? 0;
    }

    if (musicStatus === "playing") {
      return musicAudioRef.current?.currentTime ?? 0;
    }

    if (micStatus === "listening") {
      return micAudioContextRef.current?.currentTime ?? 0;
    }

    return 0;
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
    const exportFrame = shaderClock.peek(mesh.frame);
    const exportOverlay = getRenderableOverlay(visualOverlay);
    const waveformTimestampSeconds =
      getWaveformPreviewTimestampSeconds();
    await waitForFontsReady();
    const overlayImage = await loadOverlayImage(exportOverlay);
    const qrImage = exportOverlay.showBottomCta && exportOverlay.bottomRight === "qr"
      ? await loadQrCodeImage(exportOverlay.tone)
      : null;
    const topLogoImage = exportOverlay.showTopLogo
      ? await loadTopLogoImage(exportOverlay)
      : null;

    for (const target of targets) {
      const dataUrl = await captureTargetPng(
        target.handle,
        scale,
        target.format,
        exportOverlay,
        audioSpectrum,
        audioLevel,
        overlayImage,
        qrImage,
        topLogoImage,
        waveformStyle,
        exportFrame,
        waveformTimestampSeconds,
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
    const formatsToExport = singleFormatOptions.filter((option) =>
      exportFormats.has(option.label),
    );

    if (
      formatsToExport.length === 0 ||
      isExportingVideo ||
      isExportingVideoRef.current ||
      videoExportLaunchPendingRef.current
    ) {
      return;
    }

    // Acquire a synchronous mutex before the first await. A double click while
    // a directory picker or OPFS setup is pending must never launch a second
    // encoder job that cannot be cancelled through the active controller.
    videoExportLaunchPendingRef.current = true;

    // This must remain the first awaited operation: browsers only allow the
    // directory picker while the export button's user activation is alive.
    let destination: Awaited<
      ReturnType<typeof prepareVideoOutputDestination>
    >;

    try {
      destination = await prepareVideoOutputDestination({
        fileCount: formatsToExport.length,
      });
    } catch (error) {
      videoExportLaunchPendingRef.current = false;
      console.error("Could not prepare video output", error);
      window.alert(getVideoExportErrorMessage(error));
      return;
    }

    if (!destination) {
      videoExportLaunchPendingRef.current = false;
      return;
    }

    videoExportLaunchPendingRef.current = false;
    isExportingVideoRef.current = true;
    audioPreviewSessionRef.current += 1;
    const abortController = new AbortController();
    const signal = abortController.signal;
    const baseName = slugify(generateVisualName());
    const exportAudioSource = videoAudioSource;
    const currentRenderMesh = stageRef.current?.getCurrentMesh() ?? mesh;
    const exportMesh = normalizeRenderMesh(currentRenderMesh);
    const exportBlobs = cloneBlobs(blobs);
    const exportBackgroundColor = backgroundColor;
    const exportOverlay = getRenderableOverlay(visualOverlay);
    const exportWaveformStyle = getWaveformStyle(waveformStyle);
    const exportOptions: VideoExportOptions = {
      audioSource: exportAudioSource,
      bitratePreset: videoBitratePreset,
      durationSeconds: effectiveVideoDurationSeconds,
      frameRate: videoFrameRate,
      isLoopable: isVideoLoopEnabled,
    };

    videoExportAbortRef.current = abortController;
    setVideoExportNotice(null);
    setIsExportingVideo(true);
    setVideoExportProgress({
      attempt: 1,
      completedFormats: 0,
      formatIndex: 0,
      formatLabel:
        exportAudioSource === "microphone" ? "Capturing microphone" : "Preparing",
      maxAttempts: videoFormatMaxAttempts,
      overallProgress: 0,
      progress: 0,
      totalFormats: formatsToExport.length,
    });

    // Offline export owns both clocks while it is active. Stop every preview
    // media/analyser loop up front so a long multi-format job does not compete
    // with 60 fps React updates and the five preview WebGL contexts. The live
    // microphone track remains available when it is the selected input.
    stopMusicPlayback();
    stopVoicePlayback(true);
    window.cancelAnimationFrame(micFrameRef.current);
    micFrameRef.current = 0;
    clearAudioMeters();
    if (exportAudioSource === "file") {
      // File preview is intentionally stopped for the long offline job. Clear
      // its per-job selection so the next click enables and previews it once,
      // instead of requiring a confusing disable-then-enable double toggle.
      setVideoAudioSource("none");
    }

    const completedVideoFormats: CompletedVideoExportFormat[] = [];
    const failedVideoFormats: FailedVideoExportFormat[] = [];

    try {
      const [
        { createAudioAnalysisTimelineAsync },
        { captureMicrophoneAudioBuffer },
        { detectOfflineVideoEncoderSupport, encodeOfflineVideo },
      ] = await Promise.all([
        import("./export/audioAnalysis"),
        import("./export/captureMicrophoneAudio"),
        import("./export/videoEncoder"),
      ]);
      throwIfVideoExportAborted(signal);

      let exportAudioBuffer: AudioBuffer | undefined;
      let resolvedDurationSeconds = exportOptions.durationSeconds;

      if (exportAudioSource === "file") {
        exportAudioBuffer = await loadAudioBuffer(audioSource, signal);
        resolvedDurationSeconds = exportAudioBuffer.duration;
      } else if (exportAudioSource === "microphone") {
        const micStream = micStreamRef.current;

        if (!micStream) {
          throw new Error(
            "Microphone is not active. Start microphone listening before exporting.",
          );
        }

        exportAudioBuffer = await captureMicrophoneAudioBuffer(
          micStream,
          exportOptions.durationSeconds,
          signal,
          (progress) => {
            setVideoExportProgress({
              attempt: 1,
              completedFormats: 0,
              formatIndex: 0,
              formatLabel: "Capturing microphone",
              maxAttempts: videoFormatMaxAttempts,
              overallProgress:
                Math.max(0, Math.min(1, progress)) *
                microphoneCaptureProgressWeight,
              progress: Math.min(0.95, progress),
              totalFormats: formatsToExport.length,
            });
          },
        );
        resolvedDurationSeconds = Math.min(
          exportOptions.durationSeconds,
          exportAudioBuffer.duration,
        );
      }

      throwIfVideoExportAborted(signal);
      await waitForFontsReady();
      const [overlayImage, qrImage, topLogoImage] = await Promise.all([
        loadOverlayImage(exportOverlay),
        exportOverlay.showBottomCta && exportOverlay.bottomRight === "qr"
          ? loadQrCodeImage(exportOverlay.tone)
          : Promise.resolve(null),
        exportOverlay.showTopLogo
          ? loadTopLogoImage(exportOverlay)
          : Promise.resolve(null),
      ]);
      throwIfVideoExportAborted(signal);

      const audioAnalysisTimeline = exportAudioBuffer
        ? await createAudioAnalysisTimelineAsync(
            exportAudioBuffer,
            exportOptions.frameRate,
            {
              ...getAudioEnvelope(exportMesh.audioSmoothness),
              durationSeconds: resolvedDurationSeconds,
              signal,
              onProgress: (progress) => {
                const analysisStart =
                  exportAudioSource === "microphone"
                    ? microphoneCaptureProgressWeight
                    : 0;
                setVideoExportProgress({
                  attempt: 1,
                  completedFormats: 0,
                  formatIndex: 0,
                  formatLabel: "Analysing audio",
                  maxAttempts: videoFormatMaxAttempts,
                  overallProgress:
                    analysisStart +
                    Math.max(0, Math.min(1, progress)) *
                      (videoPreparationProgressWeight - analysisStart),
                  progress,
                  totalFormats: formatsToExport.length,
                });
              },
            },
          )
        : undefined;

      setVideoExportProgress({
        attempt: 1,
        completedFormats: 0,
        formatIndex: 0,
        formatLabel: "Checking formats",
        maxAttempts: videoFormatMaxAttempts,
        overallProgress: videoPreparationProgressWeight,
        progress: 0,
        totalFormats: formatsToExport.length,
      });
      await assertVideoExportFormatsSupported({
        audioBuffer: exportAudioBuffer,
        bitratePreset: exportOptions.bitratePreset,
        detectOfflineVideoEncoderSupport,
        formats: formatsToExport,
        outputFormat: videoFormat,
        signal,
      });

      for (const [formatIndex, formatToExport] of formatsToExport.entries()) {
        throwIfVideoExportAborted(signal);
        const filename = `${baseName}-${Math.max(
          1,
          Math.round(resolvedDurationSeconds),
        )}s${exportOptions.isLoopable ? "-loop" : ""}-${formatSlug(
          formatToExport,
        )}.${videoFormat}`;
        let completedFormat = false;
        let lastFormatError: unknown;

        for (
          let attemptIndex = 0;
          attemptIndex < videoFormatMaxAttempts;
          attemptIndex += 1
        ) {
          throwIfVideoExportAborted(signal);
          const attempt = attemptIndex + 1;
          const attemptScope = createVideoExportAttemptScope(
            signal,
            formatToExport.label,
          );
          let outputFile:
            | import("./export/outputDestination").VideoOutputFile
            | null = null;

          setVideoExportProgress({
            attempt,
            completedFormats: completedVideoFormats.length,
            formatIndex,
            formatLabel: formatToExport.label,
            maxAttempts: videoFormatMaxAttempts,
            overallProgress: getVideoFormatOverallProgress(
              formatIndex,
              0,
              formatsToExport.length,
            ),
            progress: 0,
            totalFormats: formatsToExport.length,
          });

          try {
            outputFile = await raceWithAbortSignal(
              destination.createFile(filename),
              attemptScope.signal,
            );
            attemptScope.heartbeat();
            const reportTargetProgress = createThrottledProgressReporter(
              (progress) => {
                setVideoExportProgress({
                  attempt,
                  completedFormats: completedVideoFormats.length,
                  formatIndex,
                  formatLabel: formatToExport.label,
                  maxAttempts: videoFormatMaxAttempts,
                  overallProgress: getVideoFormatOverallProgress(
                    formatIndex,
                    progress,
                    formatsToExport.length,
                  ),
                  progress,
                  totalFormats: formatsToExport.length,
                });
              },
            );
            const completedFile = await raceWithAbortSignal(
              renderAndEncodeVideoTarget({
                audioAnalysisTimeline,
                audioBuffer: exportAudioBuffer,
                backgroundColor: exportBackgroundColor,
                bitrate: getCompressedVideoBitrate(
                  formatToExport,
                  exportOptions.bitratePreset,
                ),
                blobs: exportBlobs,
                durationSeconds: resolvedDurationSeconds,
                encodeOfflineVideo,
                format: formatToExport,
                frameRate: exportOptions.frameRate,
                hardwareAcceleration:
                  attemptIndex === 0
                    ? "no-preference"
                    : "prefer-software",
                isLoopable: exportOptions.isLoopable,
                mesh: exportMesh,
                onProgress: (progress) => {
                  attemptScope.heartbeat();
                  reportTargetProgress(progress);
                },
                outputFile,
                outputFormat: videoFormat,
                overlay: exportOverlay,
                overlayImage,
                qrImage,
                signal: attemptScope.signal,
                topLogoImage,
                waveformStyle: exportWaveformStyle,
              }),
              attemptScope.signal,
            );

            completedVideoFormats.push({
              filename: completedFile.filename,
              formatLabel: formatToExport.label,
              sizeBytes: completedFile.sizeBytes,
            });
            completedFormat = true;
            setVideoExportProgress({
              attempt,
              completedFormats: completedVideoFormats.length,
              formatIndex,
              formatLabel: formatToExport.label,
              maxAttempts: videoFormatMaxAttempts,
              overallProgress: getVideoFormatOverallProgress(
                formatIndex,
                1,
                formatsToExport.length,
              ),
              progress: 1,
              totalFormats: formatsToExport.length,
            });
            break;
          } catch (error) {
            lastFormatError = error;
            await outputFile?.discard().catch((discardError) => {
              console.warn(
                `Could not clean up failed ${formatToExport.label} export.`,
                discardError,
              );
            });

            if (signal.aborted) {
              throw signal.reason ?? error;
            }

            console.error(
              `Video export attempt ${attempt}/${videoFormatMaxAttempts} failed for ${formatToExport.label}.`,
              error,
            );

            if (isFatalVideoOutputError(error)) {
              throw error;
            }

            if (attempt < videoFormatMaxAttempts) {
              await waitForVideoEncoderRecovery(signal);
            }
          } finally {
            attemptScope.dispose();
          }
        }

        if (!completedFormat) {
          failedVideoFormats.push({
            formatLabel: formatToExport.label,
            reason: getErrorMessage(lastFormatError),
          });
        }

        if (formatIndex + 1 < formatsToExport.length) {
          await waitForVideoEncoderRecovery(signal);
        }
      }

      const batchNotice = createVideoExportBatchNotice(
        completedVideoFormats,
        failedVideoFormats,
        formatsToExport.length,
      );
      setVideoExportNotice(batchNotice);

      if (batchNotice.kind === "error") {
        window.alert(batchNotice.message);
      }
    } catch (error) {
      if (isAbortError(error) || signal.aborted) {
        setVideoExportNotice({
          kind: "error",
          message: `Video export cancelled after ${completedVideoFormats.length}/${formatsToExport.length} formats were saved.`,
        });
      } else {
        console.error("Video export failed", error);
        const message = `${getVideoExportErrorMessage(error)} Saved ${completedVideoFormats.length}/${formatsToExport.length} formats before the failure.`;
        setVideoExportNotice({ kind: "error", message });
        window.alert(message);
      }
    } finally {
      if (videoExportAbortRef.current === abortController) {
        videoExportAbortRef.current = null;
      }
      videoExportLaunchPendingRef.current = false;
      isExportingVideoRef.current = false;
      clearAudioMeters();
      setIsExportingVideo(false);
      setVideoExportProgress(null);

      if (
        exportAudioSource === "microphone"
      ) {
        const hasLiveMicrophoneTrack = micStreamRef.current
          ?.getAudioTracks()
          .some((track) => track.readyState === "live");

        if (hasLiveMicrophoneTrack && micAnalyserRef.current) {
          updateMicLevel();
        } else {
          stopMicrophone();
          clearAudioMeters();
        }
      }
    }
  };

  const loadVisual = (visual: VisualSnapshot) => {
    const nextMesh = applyPresetAudioDefaults(normalizeRenderMesh(visual.mesh));

    activatePresetPreviewDefaults();
    setBackgroundColor(visual.backgroundColor);
    setBlobs(cloneBlobs(visual.blobs));
    grainMixerRef.current = nextMesh.grainMixer;
    setMesh(nextMesh);
    setVisualOverlay(normalizeOverlay(visual.overlay));
    setTimelineFrame(
      isPaused ? timelineScrubCenter : clampFrame(nextMesh.frame),
    );
    setPausedFrame(nextMesh.frame);
    setFrameOffset(0);
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
    spectrumStateRef: { current: LiveAudioSpectrumState | null },
    frameRef: typeof musicFrameRef,
    updateFrame: FrameRequestCallback,
    timestampMs: number,
  ) => {
    if (!analyser) {
      clearAudioMeters();
      return;
    }

    spectrumStateRef.current ??= createLiveAudioSpectrumState(analyser);
    const nextSpectrum = updateLiveAudioSpectrum(
      analyser,
      spectrumStateRef.current,
      audioSmoothnessRef.current,
      timestampMs,
    );
    const nextBands = new Float32Array(8);
    writeSpectrumBands(nextSpectrum, nextBands);

    // The canonical analyser has already applied the same attack/release
    // envelope used by offline export. React receives snapshots only; neither
    // the UI nor ShaderRenderer applies a second, divergent EMA.
    setAudioBands(Array.from(nextBands));
    setAudioSpectrum(Array.from(nextSpectrum));
    setAudioLevel(getSpectrumLevel(nextSpectrum));
    frameRef.current = window.requestAnimationFrame(updateFrame);
  };

  const updateMusicLevel = (timestampMs = performance.now()) => {
    updateAudioLevel(
      musicAnalyserRef.current,
      musicSpectrumStateRef,
      musicFrameRef,
      updateMusicLevel,
      timestampMs,
    );
  };

  const updateMicLevel = (timestampMs = performance.now()) => {
    updateAudioLevel(
      micAnalyserRef.current,
      micSpectrumStateRef,
      micFrameRef,
      updateMicLevel,
      timestampMs,
    );
  };

  const updateVoiceLevel = (timestampMs = performance.now()) => {
    updateAudioLevel(
      voiceAnalyserRef.current,
      voiceSpectrumStateRef,
      voiceFrameRef,
      updateVoiceLevel,
      timestampMs,
    );
  };

  const isCurrentAudioPreviewSession = (session: number) =>
    session === audioPreviewSessionRef.current &&
    !isExportingVideoRef.current;

  const stopMusicPlayback = () => {
    audioPreviewSessionRef.current += 1;
    musicAudioRef.current?.pause();
    window.cancelAnimationFrame(musicFrameRef.current);
    musicFrameRef.current = 0;
    musicSpectrumStateRef.current = null;
    setMusicStatus("idle");
  };

  const stopMicrophone = (preserveVideoAudioSource = false) => {
    audioPreviewSessionRef.current += 1;
    window.cancelAnimationFrame(micFrameRef.current);
    micFrameRef.current = 0;
    micSpectrumStateRef.current = null;
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micSourceRef.current?.disconnect();
    micAnalyserRef.current?.disconnect();
    void micAudioContextRef.current?.close();
    micStreamRef.current = null;
    micSourceRef.current = null;
    micAnalyserRef.current = null;
    micAudioContextRef.current = null;
    setMicStatus("idle");
    if (!preserveVideoAudioSource) {
      setVideoAudioSource((currentSource) =>
        currentSource === "microphone" ? "none" : currentSource,
      );
    }
  };

  const stopVoicePlayback = (preserveVideoAudioSource = false) => {
    audioPreviewSessionRef.current += 1;
    voiceAudioRef.current?.pause();
    window.cancelAnimationFrame(voiceFrameRef.current);
    voiceFrameRef.current = 0;
    voiceSpectrumStateRef.current = null;
    setVoiceStatus("idle");
    if (!preserveVideoAudioSource) {
      setVideoAudioSource((currentSource) =>
        currentSource === "file" ? "none" : currentSource,
      );
    }
  };

  const toggleMusic = async () => {
    if (
      isExportingVideoRef.current ||
      videoExportLaunchPendingRef.current
    ) {
      return;
    }

    if (musicStatus === "playing") {
      stopMusicPlayback();
      setAudioBands(Array(8).fill(0));
      setAudioSpectrum(Array(64).fill(0));
      setAudioLevel(0);
      return;
    }

    stopVoicePlayback();
    stopMicrophone();
    const previewSession = ++audioPreviewSessionRef.current;
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
        configureLiveAudioAnalyser(analyser);
        source.connect(analyser);
        connectMonoOutput(audioContext, analyser);
        musicSourceRef.current = source;
        musicAnalyserRef.current = analyser;
      }

      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }

      if (!isCurrentAudioPreviewSession(previewSession)) {
        audio.pause();
        return;
      }

      await audio.play();

      if (!isCurrentAudioPreviewSession(previewSession)) {
        audio.pause();
        return;
      }

      setMusicStatus("playing");
      updateMusicLevel();
    } catch {
      if (!isCurrentAudioPreviewSession(previewSession)) {
        return;
      }

      setMusicStatus("idle");
      setAudioBands(Array(8).fill(0));
      setAudioSpectrum(Array(64).fill(0));
      setAudioLevel(0);
      setVoiceNotice("Music playback failed. Try clicking the music button again.");
    }
  };

  const toggleMicrophone = async () => {
    if (
      isExportingVideoRef.current ||
      videoExportLaunchPendingRef.current
    ) {
      return;
    }

    if (videoAudioSource === "microphone" || micStatus === "listening") {
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
    const previewSession = ++audioPreviewSessionRef.current;
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

      if (!isCurrentAudioPreviewSession(previewSession)) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      stream.getAudioTracks().forEach((track) => {
        track.onended = () => {
          if (micStreamRef.current !== stream) {
            return;
          }

          stopMicrophone();
          setAudioBands(Array(8).fill(0));
          setAudioSpectrum(Array(64).fill(0));
          setAudioLevel(0);
        };
      });
      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      configureLiveAudioAnalyser(analyser);
      source.connect(analyser);

      micStreamRef.current = stream;
      micAudioContextRef.current = audioContext;
      micSourceRef.current = source;
      micAnalyserRef.current = analyser;

      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }

      if (!isCurrentAudioPreviewSession(previewSession)) {
        stream.getTracks().forEach((track) => track.stop());
        source.disconnect();
        analyser.disconnect();
        await audioContext.close().catch(() => undefined);

        if (micStreamRef.current === stream) {
          micStreamRef.current = null;
          micSourceRef.current = null;
          micAnalyserRef.current = null;
          micAudioContextRef.current = null;
        }
        return;
      }

      setVideoAudioSource("microphone");
      setMicStatus("listening");
      updateMicLevel();
    } catch (error) {
      if (!isCurrentAudioPreviewSession(previewSession)) {
        return;
      }

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
    if (
      isExportingVideoRef.current ||
      videoExportLaunchPendingRef.current
    ) {
      return;
    }

    if (videoAudioSource === "file" || voiceStatus !== "idle") {
      stopVoicePlayback();
      setAudioBands(Array(8).fill(0));
      setAudioSpectrum(Array(64).fill(0));
      setAudioLevel(0);
      setVoiceNotice("");
      return;
    }

    stopMusicPlayback();
    stopMicrophone();
    const previewSession = ++audioPreviewSessionRef.current;
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
        configureLiveAudioAnalyser(analyser);
        source.connect(analyser);
        connectMonoOutput(audioContext, analyser);
        voiceSourceRef.current = source;
        voiceAnalyserRef.current = analyser;
      }

      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }

      if (!isCurrentAudioPreviewSession(previewSession)) {
        audio.pause();
        return;
      }

      audio.onended = () => {
        if (!isCurrentAudioPreviewSession(previewSession)) {
          return;
        }

        window.cancelAnimationFrame(voiceFrameRef.current);
        setVoiceStatus("idle");
        setAudioBands(Array(8).fill(0));
        setAudioSpectrum(Array(64).fill(0));
        setAudioLevel(0);
      };
      audio.onerror = () => {
        if (!isCurrentAudioPreviewSession(previewSession)) {
          return;
        }

        window.cancelAnimationFrame(voiceFrameRef.current);
        setVoiceStatus("idle");
        setVideoAudioSource("none");
        setAudioBands(Array(8).fill(0));
        setAudioSpectrum(Array(64).fill(0));
        setAudioLevel(0);
        setVoiceNotice("MP3 playback failed. Try clicking the audio button again.");
      };

      await audio.play();

      if (!isCurrentAudioPreviewSession(previewSession)) {
        audio.pause();
        return;
      }

      setVideoAudioSource("file");
      setVoiceStatus("playing");
      updateVoiceLevel();
    } catch (error) {
      if (!isCurrentAudioPreviewSession(previewSession)) {
        return;
      }

      setVoiceStatus("idle");
      setVideoAudioSource("none");
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

  const waveformPreviewTimestampSeconds =
    getWaveformPreviewTimestampSeconds();

  const renderPreviewFormat = (previewFormat: SingleFormatOption) => {
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
              "--scene-horizontal-padding": `${
                (getSceneHorizontalPadding(previewFormat.exportWidth) /
                  previewFormat.exportWidth) *
                100
              }cqw`,
              aspectRatio: `${previewFormat.width} / ${previewFormat.height}`,
            } as CSSProperties
          }
        >
          <ShaderStage
            audioBands={audioBands}
            audioLevel={audioLevel}
            clock={shaderClock}
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
            format={previewFormat}
            frameShape={frameShape}
            overlay={visualOverlay}
            waveformStyle={waveformStyle}
            waveformTimestampSeconds={waveformPreviewTimestampSeconds}
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
  };

  return (
    <main className="app-shell" data-theme={uiTheme} style={previewGridStyle}>
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
        aria-busy={isExportingVideo}
        inert={isExportingVideo}
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
                    disabled={isExportingVideo}
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
                    className="h-auto min-h-10 w-full justify-between whitespace-normal px-3 py-2 text-left"
                    disabled={isExportingVideo || exportFormats.size === 0}
                    type="button"
                    variant="secondary"
                    onClick={() => exportVideo(videoExportFormat)}
                  >
                    <span>
                      {isExportingVideo
                        ? "Exporting..."
                        : exportFormats.size > 1
                          ? `Export Video (${exportFormats.size} formats)`
                          : "Export Video"}
                    </span>
                    <span className="flex shrink-0 items-center gap-1 text-xs font-bold opacity-70">
                      {videoAudioSource === "file" ? (
                        <Volume2 className="size-3.5" aria-hidden="true" />
                      ) : videoAudioSource === "microphone" ? (
                        <Mic className="size-3.5" aria-hidden="true" />
                      ) : (
                        <VolumeX className="size-3.5" aria-hidden="true" />
                      )}
                      {videoAudioStatusLabel}
                    </span>
                  </Button>
                  <ExportVideoSettings
                    audioDurationSeconds={audioDurationSeconds}
                    audioSource={videoAudioSource}
                    bitratePreset={videoBitratePreset}
                    disabled={isExportingVideo}
                    durationSeconds={videoDuration}
                    frameRate={videoFrameRate}
                    isLoopEnabled={isVideoLoopEnabled}
                    videoFormat={videoExportFormat}
                    onBitratePresetChange={setVideoBitratePreset}
                    onDurationChange={setVideoDuration}
                    onFrameRateChange={setVideoFrameRate}
                    onLoopEnabledChange={setIsVideoLoopEnabled}
                    onVideoFormatChange={setVideoExportFormat}
                  />
                </div>
                {videoExportNotice ? (
                  <p
                    aria-live="polite"
                    className={cn(
                      "rounded-md border px-3 py-2 text-xs font-semibold",
                      videoExportNotice.kind === "success"
                        ? "border-emerald-500/35 text-emerald-700"
                        : "border-red-500/35 text-red-700",
                    )}
                    role="status"
                  >
                    {videoExportNotice.message}
                  </p>
                ) : null}
              </div>
            </div>

            <label className="grid gap-2">
              <span className="text-xs font-bold uppercase text-[var(--muted-foreground)]">
                Audio File
              </span>
              <span className="audio-file-input">
                <input
                  accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg"
                  disabled={isExportingVideo}
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
                    {formatTimelineFrame(
                      isPaused ? pausedFrame + frameOffset : timelineFrame,
                    )}
                  </strong>
                </span>
                <Slider
                  aria-label="Timeline"
                  className="timeline-slider"
                  data-frame-offset={Math.round(frameOffset)}
                  data-render-frame={Math.round(
                    isPaused ? pausedFrame + frameOffset : timelineFrame,
                  )}
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
                disabled={isExportingVideo || musicStatus === "loading"}
                size="icon"
                type="button"
                variant={musicStatus === "playing" ? "secondary" : "outline"}
                onClick={toggleMusic}
              >
                <AudioLines className="size-4" aria-hidden="true" />
              </Button>
              <Button
                aria-label={videoAudioSource === "microphone" ? "Disable microphone audio" : "Enable microphone audio"}
                aria-pressed={videoAudioSource === "microphone"}
                disabled={isExportingVideo || micStatus === "loading"}
                size="icon"
                type="button"
                variant={videoAudioSource === "microphone" ? "default" : "outline"}
                onClick={toggleMicrophone}
              >
                <Mic className="size-4" aria-hidden="true" />
              </Button>
              <Button
                aria-label={videoAudioSource === "file" ? "Disable file audio" : "Enable file audio"}
                aria-pressed={videoAudioSource === "file"}
                disabled={isExportingVideo || voiceStatus === "loading"}
                size="icon"
                type="button"
                variant={videoAudioSource === "file" ? "default" : "outline"}
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

            <AutoRandomizeSettings
              colorInterval={colorRandomizeInterval}
              colorsEnabled={autoRandomizeColors}
              disabled={isExportingVideo}
              waveformEnabled={autoRandomizeWaveform}
              waveformInterval={waveformRandomizeInterval}
              onColorIntervalChange={setColorRandomizeInterval}
              onColorsEnabledChange={setAutoRandomizeColors}
              onWaveformEnabledChange={setAutoRandomizeWaveform}
              onWaveformIntervalChange={setWaveformRandomizeInterval}
            />

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
          <div
            className="format-overview"
            data-format-count={visiblePreviewFormats.length}
            data-primary-format={primaryPreviewFormat.label}
          >
            {renderPreviewFormat(primaryPreviewFormat)}
            <div className="format-overview-wing format-overview-wing-left">
              {leftPreviewFormats.map(renderPreviewFormat)}
            </div>
            <div className="format-overview-wing format-overview-wing-right">
              {rightPreviewFormats.map(renderPreviewFormat)}
            </div>
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
              <span className="recording-progress-detail">
                Format {(videoExportProgress?.formatIndex ?? 0) + 1}/
                {videoExportProgress?.totalFormats ?? 1}
                {" · "}
                {videoExportProgress?.completedFormats ?? 0} saved
                {(videoExportProgress?.attempt ?? 1) > 1
                  ? ` · retry ${videoExportProgress?.attempt}/${videoExportProgress?.maxAttempts}`
                  : ""}
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

function formatVideoDurationLabel(duration: VideoDuration) {
  if (duration <= 60) {
    return `${duration} seconds`;
  }

  return `${duration / 60} minutes`;
}

function formatMediaDurationLabel(durationSeconds: number) {
  const totalSeconds = Math.max(0, Math.round(durationSeconds));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

type ExportVideoSettingsProps = {
  audioDurationSeconds: number | null;
  audioSource: VideoAudioSource;
  bitratePreset: VideoBitratePreset;
  disabled: boolean;
  durationSeconds: VideoDuration;
  frameRate: VideoFrameRate;
  isLoopEnabled: boolean;
  onBitratePresetChange: (preset: VideoBitratePreset) => void;
  onDurationChange: (duration: VideoDuration) => void;
  onFrameRateChange: (frameRate: VideoFrameRate) => void;
  onLoopEnabledChange: (enabled: boolean) => void;
  onVideoFormatChange: (format: VideoExportFormat) => void;
  videoFormat: VideoExportFormat;
};

function ExportVideoSettings({
  audioDurationSeconds,
  audioSource,
  bitratePreset,
  disabled,
  durationSeconds,
  frameRate,
  isLoopEnabled,
  onBitratePresetChange,
  onDurationChange,
  onFrameRateChange,
  onLoopEnabledChange,
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
            Duration
          </div>
          {audioSource === "file" ? (
            <div className="grid min-h-9 w-full grid-cols-[1rem_minmax(0,1fr)] items-center gap-3 px-3 text-sm font-semibold">
              <span className="flex size-4 items-center justify-center">
                <Check className="size-4" aria-hidden="true" />
              </span>
              <span>
                {audioDurationSeconds
                  ? `Audio duration · ${formatMediaDurationLabel(audioDurationSeconds)}`
                  : "Audio duration"}
              </span>
            </div>
          ) : (
            ([15, 30, 60, 120, 240] as const).map((durationOption) => (
              <MenuCheckItem
                isSelected={durationSeconds === durationOption}
                key={durationOption}
                label={formatVideoDurationLabel(durationOption)}
                onClick={() => onDurationChange(durationOption)}
              />
            ))
          )}
          {audioSource === "none" ? (
            <MenuCheckItem
              isSelected={isLoopEnabled}
              label="Visual loop fade"
              onClick={() => onLoopEnabledChange(!isLoopEnabled)}
            />
          ) : (
            <div className="px-3 py-2 text-xs text-[var(--muted-foreground)]">
              Visual loop fade is unavailable with audio.
            </div>
          )}
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
      className="grid min-h-9 w-full grid-cols-[1rem_minmax(0,1fr)] items-center gap-3 rounded px-3 text-left text-sm font-semibold transition hover:bg-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      onClick={onClick}
      role="menuitemcheckbox"
      type="button"
    >
      <span className="flex size-4 items-center justify-center">
        {isSelected ? <Check className="size-4" aria-hidden="true" /> : null}
      </span>
      <span>{label}</span>
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

type AutoRandomizeSettingsProps = {
  colorInterval: AutoRandomizeInterval;
  colorsEnabled: boolean;
  disabled: boolean;
  onColorIntervalChange: (interval: AutoRandomizeInterval) => void;
  onColorsEnabledChange: (enabled: boolean) => void;
  onWaveformEnabledChange: (enabled: boolean) => void;
  onWaveformIntervalChange: (interval: AutoRandomizeInterval) => void;
  waveformEnabled: boolean;
  waveformInterval: AutoRandomizeInterval;
};

function AutoRandomizeSettings({
  colorInterval,
  colorsEnabled,
  disabled,
  onColorIntervalChange,
  onColorsEnabledChange,
  onWaveformEnabledChange,
  onWaveformIntervalChange,
  waveformEnabled,
  waveformInterval,
}: AutoRandomizeSettingsProps) {
  return (
    <section className="grid gap-3 border-t border-[var(--border)] pt-5">
      <h2 className="text-base font-bold text-[var(--foreground)]">
        Auto Randomize
      </h2>
      <div className="grid gap-3 rounded-md border border-[var(--border)] bg-[var(--background)]/30 p-3">
        <SwitchField
          checked={colorsEnabled}
          disabled={disabled}
          label="Randomize Colors"
          onChange={onColorsEnabledChange}
        />
        <SelectField
          disabled={disabled}
          label="Colors every"
          value={colorInterval}
          onChange={(value) => onColorIntervalChange(value as AutoRandomizeInterval)}
        >
          {autoRandomizeIntervalOptions().map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectField>
      </div>
      <div className="grid gap-3 rounded-md border border-[var(--border)] bg-[var(--background)]/30 p-3">
        <SwitchField
          checked={waveformEnabled}
          disabled={disabled}
          label="Randomize Waveform"
          onChange={onWaveformEnabledChange}
        />
        <SelectField
          disabled={disabled}
          label="Waveform every"
          value={waveformInterval}
          onChange={(value) => onWaveformIntervalChange(value as AutoRandomizeInterval)}
        >
          {autoRandomizeIntervalOptions().map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectField>
      </div>
    </section>
  );
}

type SwitchFieldProps = {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
};

function SwitchField({
  checked,
  disabled = false,
  label,
  onChange,
}: SwitchFieldProps) {
  return (
    <button
      aria-checked={checked}
      disabled={disabled}
      role="switch"
      type="button"
      className={cn(
        "flex min-h-10 items-center justify-between gap-3 rounded-md text-left text-sm font-semibold text-[var(--foreground)] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed",
        disabled && "opacity-55",
      )}
      onClick={() => onChange(!checked)}
    >
      <span>{label}</span>
      <span
        className={cn(
          "flex h-6 w-11 items-center rounded-full border border-[var(--border)] p-0.5 transition",
          checked ? "bg-[var(--primary)]" : "bg-[var(--muted)]",
        )}
        aria-hidden="true"
      >
        <span
          className={cn(
            "block size-4 rounded-full bg-[var(--background)] shadow-sm transition-transform",
          )}
          style={{ transform: checked ? "translateX(18px)" : "translateX(0)" }}
        />
      </span>
    </button>
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
  const isCenterLogoOnly = overlay.centerLogoOnly;

  return (
    <section className="grid gap-3 border-t border-[var(--border)] pt-5">
      <h2 className="text-base font-bold text-[var(--foreground)]">Overlay</h2>
      <SelectField
        label="Center visual"
        value={isCenterLogoOnly ? "logo-only" : "waveform"}
        onChange={(value) =>
          updateOverlay({
            asset: value === "logo-only" ? "logo" : "waveform",
            centerLogoOnly: value === "logo-only",
          })
        }
      >
        <option value="waveform">Waveform</option>
        <option value="logo-only">Large logo only</option>
      </SelectField>
      {isCenterLogoOnly ? (
        <SelectField
          label="Logo size"
          value={overlay.centerLogoSize}
          onChange={(value) =>
            updateOverlay({ centerLogoSize: value as CenterLogoSize })
          }
        >
          <option value="33">33%</option>
          <option value="50">50%</option>
        </SelectField>
      ) : (
        <>
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
        </>
      )}
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
  disabled?: boolean;
  label: string;
  onChange: (value: string) => void;
  value: string;
};

function SelectField({
  children,
  disabled = false,
  label,
  onChange,
  value,
}: SelectFieldProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const labelId = useId();
  const options = getSelectOptions(children);
  const selectedOption =
    options.find((option) => option.value === value) ?? options[0];

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

  const selectOption = (nextValue: string) => {
    onChange(nextValue);
    setIsOpen(false);
  };

  return (
    <div
      className={cn("relative grid gap-2", disabled && "opacity-55")}
      ref={menuRef}
    >
      <span
        className="text-xs font-bold uppercase text-[var(--muted-foreground)]"
        id={labelId}
      >
        {label}
      </span>
      <button
        aria-label={label}
        aria-controls={`${labelId}-listbox`}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        className="grid min-h-10 w-full grid-cols-[minmax(0,1fr)_1rem] items-center gap-3 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-left text-sm font-semibold text-[var(--foreground)] outline-none transition hover:bg-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-70 focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        disabled={disabled}
        role="combobox"
        type="button"
        onClick={() => setIsOpen((currentValue) => !currentValue)}
      >
        <span className="truncate">
          {selectedOption?.label ?? value}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-4 justify-self-center text-[var(--muted-foreground)] transition-transform",
            isOpen && "rotate-180",
          )}
        />
      </button>
      {isOpen ? (
        <div
          className="absolute left-0 right-0 top-[calc(100%+6px)] z-50 rounded-md border border-[var(--border)] bg-[var(--popover)] p-1 text-[var(--popover-foreground)] shadow-lg"
          id={`${labelId}-listbox`}
          role="listbox"
        >
          {options.map((option) => (
            <button
              aria-selected={option.value === value}
              className="grid min-h-9 w-full grid-cols-[1rem_minmax(0,1fr)] items-center gap-3 rounded px-3 text-left text-sm font-semibold transition hover:bg-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              key={option.value}
              role="option"
              type="button"
              onClick={() => selectOption(option.value)}
            >
              <span className="flex size-4 items-center justify-center">
                {option.value === value ? (
                  <Check className="size-4 shrink-0" aria-hidden="true" />
                ) : null}
              </span>
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function getSelectOptions(children: ReactNode) {
  return Children.toArray(children)
    .filter((child): child is ReactElement<{ children: ReactNode; value?: string }> =>
      isValidElement(child),
    )
    .map((child) => ({
      label: String(child.props.children ?? child.props.value ?? ""),
      value: String(child.props.value ?? child.props.children ?? ""),
    }));
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
  format,
  frameShape,
  overlay,
  waveformStyle,
  waveformTimestampSeconds,
}: {
  audioSpectrum: number[];
  audioLevel: number;
  format: SingleFormatOption;
  frameShape: FrameShape;
  overlay: VisualOverlay;
  waveformStyle: WaveformStyle;
  waveformTimestampSeconds: number;
}) {
  const renderOverlay = getRenderableOverlay(overlay);

  if (renderOverlay.asset === "waveform") {
    return (
      <SoundWaveOverlay
        audioSpectrum={audioSpectrum}
        audioLevel={audioLevel}
        format={format}
        tone={renderOverlay.tone}
        waveformStyle={waveformStyle}
        waveformTimestampSeconds={waveformTimestampSeconds}
      />
    );
  }

  const overlaySource = getOverlayDataUrl(renderOverlay);

  if (!overlaySource) {
    return null;
  }

  const overlayStyle = {
    "--center-logo-size": `${getCenterLogoSizePercent(renderOverlay)}%`,
    "--overlay-audio-level": renderOverlay.centerLogoOnly ? "0" : audioLevel.toFixed(3),
  } as CSSProperties;

  // Padidinam star overlay 1.5 karto TIK circle formate
  const extraScale = renderOverlay.asset === "star" && frameShape === "circle" ? 1.5 : 1;
  return (
    <span
      className={cn(
        "visual-overlay pointer-events-none absolute left-1/2 top-1/2 z-10 select-none",
        `visual-overlay-${frameShape}`,
        renderOverlay.asset === "star"
          ? "visual-overlay-star w-[35%] min-w-16 max-w-48"
          : "visual-overlay-logo w-[62%] max-w-[320px]",
        renderOverlay.centerLogoOnly && "visual-overlay-logo-only",
      )}
      style={{
        ...overlayStyle,
        transform: `translate(-50%, -50%) scale(${extraScale})`,
      }}
    >
      {renderOverlay.asset === "star" ? (
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
  format,
  tone,
  waveformStyle,
  waveformTimestampSeconds,
}: {
  audioSpectrum: number[];
  audioLevel: number;
  format: SingleFormatOption;
  tone: OverlayTone;
  waveformStyle: WaveformStyle;
  waveformTimestampSeconds: number;
}) {
  void audioLevel;
  const style = getWaveformStyle(waveformStyle);
  const geometry = getWaveformGeometry(
    format.exportWidth,
    format.exportHeight,
    style.boxScale,
  );
  const bars = createWaveformBars(
    audioSpectrum,
    style,
    {
      barCount: geometry.barCount,
      timestampSeconds: waveformTimestampSeconds,
    },
  );
  const peakHeightRatio = Math.max(
    0,
    ...bars.map((bar) => bar.heightRatio),
  );
  const edgeBlurRadius =
    Math.min(format.exportWidth, format.exportHeight) *
    WAVEFORM_EDGE_BLUR_MAX_RATIO;
  const glowBlurRadius =
    Math.min(format.exportWidth, format.exportHeight) *
    WAVEFORM_GLOW_BLUR_MAX_RATIO;
  const amplitudeScale = getWaveformAmplitudeScale(
    format.exportWidth,
    format.exportHeight,
    geometry.height,
    peakHeightRatio,
    WAVEFORM_AMPLITUDE_SCALE,
    edgeBlurRadius,
  );
  const maxGlowHeight = getWaveformMaxPeakHeight(
    format.exportWidth,
    format.exportHeight,
    edgeBlurRadius,
  );
  const getRenderedBarHeight = (
    bar: ReturnType<typeof createWaveformBars>[number],
  ) =>
    getWaveformRenderedBarHeight(
      bar.heightRatio,
      geometry.height,
      amplitudeScale,
      geometry.barWidth,
    );
  const getRenderedActivity = (
    bar: ReturnType<typeof createWaveformBars>[number],
  ) =>
    getWaveformRenderedBarOpacityScale(
      bar.heightRatio,
      geometry.height,
      amplitudeScale,
      geometry.barWidth,
    );
  const getRenderedOpacity = (
    bar: ReturnType<typeof createWaveformBars>[number],
    layer: "blur" | "sharp",
  ) => {
    const layerOpacities = getWaveformBarLayerOpacities(bar);
    const activityOpacity = getRenderedActivity(bar);

    return (
      (layer === "blur"
        ? layerOpacities.blurOpacity
        : layerOpacities.sharpOpacity) * activityOpacity
    );
  };
  const waveformCssVars = {
    "--waveform-amplitude-scale": amplitudeScale.toFixed(6),
    "--waveform-bar-width": `${
      (geometry.barWidth / format.exportWidth) * 100
    }cqw`,
    "--waveform-edge-blur": `${
      (edgeBlurRadius / format.exportWidth) * 100
    }cqw`,
    "--waveform-glow-blur": `${
      (glowBlurRadius / format.exportWidth) * 100
    }cqw`,
    "--waveform-raw-peak-height-ratio": peakHeightRatio.toFixed(6),
    "--waveform-style-box-scale": String(style.boxScale),
    height: `${(geometry.height / format.exportHeight) * 100}%`,
    width: `${(geometry.width / format.exportWidth) * 100}%`,
  } as CSSProperties;
  const getBarLeftPercent = (
    index: number,
    renderedBarWidth: number,
  ) =>
    ((getWaveformBarOffset(
      index,
      geometry.barStep,
      geometry.pixelScale,
    ) +
      geometry.barCenterInset -
      renderedBarWidth / 2) /
      geometry.width) *
    100;

  return (
    <span
      className={cn(
        "sound-wave-overlay pointer-events-none absolute left-1/2 top-1/2 z-10 select-none",
        tone === "dark" && "sound-wave-overlay-dark",
      )}
      style={waveformCssVars}
    >
      <span
        aria-hidden="true"
        className="sound-wave-overlay-track sound-wave-overlay-track-glow"
      >
        {bars.map((bar, index) => {
          const activityOpacity = getRenderedActivity(bar);
          const renderedBarHeight = getRenderedBarHeight(bar);
          const renderedBarWidth = getWaveformRenderedBarWidth(
            renderedBarHeight,
            geometry.barWidth,
          );
          const glowHeight = getWaveformGlowHeight(
            renderedBarHeight,
            geometry.height,
            activityOpacity,
            maxGlowHeight,
          );
          const centerOffset = getWaveformRenderedBarCenterOffset(
            bar.centerOffsetRatio,
            geometry.height,
            amplitudeScale,
          );

          return (
            <span
              className="sound-wave-overlay-glow-bar"
              key={index}
              style={{
                height: `${(glowHeight / geometry.height) * 100}%`,
                left: `${getBarLeftPercent(index, renderedBarWidth)}%`,
                opacity: getWaveformBarGlowOpacity(
                  bar,
                  activityOpacity,
                ),
                top: `${
                  50 + (centerOffset / geometry.height) * 100
                }%`,
                width: `${
                  (renderedBarWidth / geometry.width) * 100
                }%`,
              }}
            />
          );
        })}
      </span>
      <span className="sound-wave-overlay-track sound-wave-overlay-track-sharp">
        {bars.map((bar, index) => {
          const renderedBarHeight = getRenderedBarHeight(bar);
          const renderedBarWidth = getWaveformRenderedBarWidth(
            renderedBarHeight,
            geometry.barWidth,
          );
          const centerOffset = getWaveformRenderedBarCenterOffset(
            bar.centerOffsetRatio,
            geometry.height,
            amplitudeScale,
          );
          return (
            <span
              aria-hidden="true"
              className="sound-wave-overlay-bar"
              key={index}
              style={{
                height: `${(renderedBarHeight / geometry.height) * 100}%`,
                left: `${getBarLeftPercent(index, renderedBarWidth)}%`,
                opacity: getRenderedOpacity(bar, "sharp"),
                top: `${
                  50 + (centerOffset / geometry.height) * 100
                }%`,
                width: `${
                  (renderedBarWidth / geometry.width) * 100
                }%`,
              } as CSSProperties}
            />
          );
        })}
      </span>
      <span
        aria-hidden="true"
        className="sound-wave-overlay-track sound-wave-overlay-track-blur"
      >
        {bars.map((bar, index) => {
          const renderedBarHeight = getRenderedBarHeight(bar);
          const renderedBarWidth = getWaveformRenderedBarWidth(
            renderedBarHeight,
            geometry.barWidth,
          );
          const centerOffset = getWaveformRenderedBarCenterOffset(
            bar.centerOffsetRatio,
            geometry.height,
            amplitudeScale,
          );
          return (
            <span
              className="sound-wave-overlay-blur-bar"
              key={index}
              style={{
                height: `${(renderedBarHeight / geometry.height) * 100}%`,
                left: `${getBarLeftPercent(index, renderedBarWidth)}%`,
                opacity: getRenderedOpacity(bar, "blur"),
                top: `${
                  50 + (centerOffset / geometry.height) * 100
                }%`,
                width: `${
                  (renderedBarWidth / geometry.width) * 100
                }%`,
              } as CSSProperties}
            />
          );
        })}
      </span>
    </span>
  );
}

function SceneDecorations({
  overlay,
}: {
  overlay: VisualOverlay;
}) {
  if (overlay.centerLogoOnly) {
    return null;
  }

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
  const fadeStartMs = durationMs - fadeDurationMs;
  const progress = Math.min(
    1,
    Math.max(0, (elapsedMs - fadeStartMs) / fadeDurationMs),
  );

  return progress * progress * (3 - 2 * progress);
}

function getAutoRandomizeDelayMs(interval: AutoRandomizeInterval) {
  if (interval === "random") {
    const randomInterval =
      autoRandomizeIntervals[Math.floor(Math.random() * autoRandomizeIntervals.length)] ??
      10;

    return randomInterval * 1000;
  }

  return Number(interval) * 1000;
}

function autoRandomizeIntervalOptions() {
  return [
    ...autoRandomizeIntervals.map((interval) => ({
      label: `${interval}s`,
      value: interval.toString() as AutoRandomizeInterval,
    })),
    { label: "Random", value: "random" as const },
  ];
}

async function waitForFontsReady() {
  if (!("fonts" in document)) {
    return;
  }

  await document.fonts.ready.catch(() => undefined);
}

async function assertVideoExportFormatsSupported(options: {
  audioBuffer?: AudioBuffer;
  bitratePreset: VideoBitratePreset;
  detectOfflineVideoEncoderSupport: typeof import("./export/videoEncoder").detectOfflineVideoEncoderSupport;
  formats: readonly SingleFormatOption[];
  outputFormat: VideoExportFormat;
  signal: AbortSignal;
}) {
  const {
    audioBuffer,
    bitratePreset,
    detectOfflineVideoEncoderSupport,
    formats,
    outputFormat,
    signal,
  } = options;

  for (const format of formats) {
    throwIfVideoExportAborted(signal);
    const canvas = document.createElement("canvas");
    canvas.width = format.exportWidth;
    canvas.height = format.exportHeight;

    try {
      const support = await detectOfflineVideoEncoderSupport({
        audioBuffer,
        bitrate: getCompressedVideoBitrate(format, bitratePreset),
        canvas,
        format: outputFormat,
        hardwareAcceleration: "no-preference",
        signal,
      });

      if (!support.supported) {
        throw new Error(
          `${format.label} is not supported: ${
            support.unsupportedReason ?? "encoder configuration unavailable"
          }`,
        );
      }
    } finally {
      canvas.width = 1;
      canvas.height = 1;
    }
  }
}

function createVideoExportAttemptScope(
  parentSignal: AbortSignal,
  formatLabel: string,
) {
  const controller = new AbortController();
  let timeoutId: number | null = null;
  let isDisposed = false;
  const forwardParentAbort = () => {
    controller.abort(
      parentSignal.reason ??
        new DOMException("Video export cancelled.", "AbortError"),
    );
  };
  const heartbeat = () => {
    if (isDisposed || controller.signal.aborted) {
      return;
    }

    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }

    timeoutId = window.setTimeout(() => {
      const error = new Error(
        `${formatLabel} made no export progress for ${
          videoFormatStallTimeoutMs / 1000
        } seconds.`,
      );
      error.name = "VideoExportStallError";
      controller.abort(error);
    }, videoFormatStallTimeoutMs);
  };

  if (parentSignal.aborted) {
    forwardParentAbort();
  } else {
    parentSignal.addEventListener("abort", forwardParentAbort, {
      once: true,
    });
  }
  heartbeat();

  return {
    dispose() {
      isDisposed = true;
      parentSignal.removeEventListener("abort", forwardParentAbort);

      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
    },
    heartbeat,
    signal: controller.signal,
  };
}

function raceWithAbortSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason ??
        new DOMException("Video export cancelled.", "AbortError"),
    );
  }

  return new Promise<T>((resolve, reject) => {
    const handleAbort = () => {
      reject(
        signal.reason ??
          new DOMException("Video export cancelled.", "AbortError"),
      );
    };
    const settle = (callback: (value: T) => void, value: T) => {
      signal.removeEventListener("abort", handleAbort);
      callback(value);
    };

    signal.addEventListener("abort", handleAbort, { once: true });
    promise.then(
      (value) => settle(resolve, value),
      (error) => {
        signal.removeEventListener("abort", handleAbort);
        reject(error);
      },
    );
  });
}

async function waitForVideoEncoderRecovery(signal: AbortSignal) {
  await raceWithAbortSignal(
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, videoEncoderRecoveryDelayMs);
    }),
    signal,
  );
}

function isFatalVideoOutputError(error: unknown) {
  const errorName =
    error instanceof DOMException || error instanceof Error
      ? error.name
      : "";

  return [
    "NotAllowedError",
    "NotFoundError",
    "QuotaExceededError",
    "SecurityError",
  ].includes(errorName);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "unknown export error";
}

function createVideoExportBatchNotice(
  completedFormats: CompletedVideoExportFormat[],
  failedFormats: FailedVideoExportFormat[],
  totalFormats: number,
): VideoExportNotice {
  const totalBytes = completedFormats.reduce(
    (sum, format) => sum + format.sizeBytes,
    0,
  );

  if (failedFormats.length === 0) {
    return {
      kind: "success",
      message: `Export complete: ${completedFormats.length}/${totalFormats} formats saved (${formatByteCount(totalBytes)}).`,
    };
  }

  return {
    kind: "error",
    message:
      `Export completed partially: ${completedFormats.length}/${totalFormats} formats saved. ` +
      `Failed: ${failedFormats
        .map(({ formatLabel, reason }) => `${formatLabel} — ${reason}`)
        .join("; ")}.`,
  };
}

function formatByteCount(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / 1024 ** unitIndex;

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

async function renderAndEncodeVideoTarget(options: {
  audioAnalysisTimeline?: import("./export/audioAnalysis").AudioAnalysisTimeline;
  audioBuffer?: AudioBuffer;
  backgroundColor: string;
  bitrate: number;
  blobs: BlobConfig[];
  durationSeconds: number;
  encodeOfflineVideo: typeof import("./export/videoEncoder").encodeOfflineVideo;
  format: SingleFormatOption;
  frameRate: VideoFrameRate;
  hardwareAcceleration: import("./export/videoEncoder").OfflineVideoHardwareAcceleration;
  isLoopable: boolean;
  mesh: MeshConfig;
  onProgress: (progress: number) => void;
  outputFile: import("./export/outputDestination").VideoOutputFile;
  outputFormat: VideoExportFormat;
  overlay: VisualOverlay;
  overlayImage: HTMLImageElement | null;
  qrImage: HTMLImageElement | null;
  signal: AbortSignal;
  topLogoImage: HTMLImageElement | null;
  waveformStyle: WaveformStyle;
}) {
  const {
    audioAnalysisTimeline,
    audioBuffer,
    backgroundColor,
    bitrate,
    blobs,
    durationSeconds,
    encodeOfflineVideo,
    format,
    frameRate,
    hardwareAcceleration,
    isLoopable,
    mesh,
    onProgress,
    outputFile,
    outputFormat,
    overlay,
    overlayImage,
    qrImage,
    signal,
    topLogoImage,
    waveformStyle,
  } = options;
  const width = format.exportWidth;
  const height = format.exportHeight;
  const shaderCanvas = document.createElement("canvas");
  const outputCanvas = document.createElement("canvas");
  outputCanvas.width = width;
  outputCanvas.height = height;
  const outputContext = outputCanvas.getContext("2d", {
    alpha: false,
    desynchronized: false,
  });

  if (!outputContext) {
    throw new Error("The browser could not create the video render surface.");
  }

  const zeroBands = new Float32Array(8);
  const shaderBands = new Float32Array(8);
  let loopStartCanvas: HTMLCanvasElement | null = null;
  let loopStartContext: CanvasRenderingContext2D | null = null;
  let shaderRenderer: ShaderRenderer | null = null;

  try {
    shaderRenderer = new ShaderRenderer({
      audioBands: zeroBands,
      audioLevel: 0,
      backgroundColor,
      blobs,
      canvas: shaderCanvas,
      mesh,
      // The frame is copied into a 2D canvas immediately after each render.
      // Preserving this single, sequential export buffer avoids driver-specific
      // clearing while still keeping memory bounded to one target at a time.
      preserveDrawingBuffer: true,
      releaseContextOnDispose: true,
    });
    shaderRenderer.setSize(width, height, 1);

    if (isLoopable) {
      loopStartCanvas = document.createElement("canvas");
      loopStartCanvas.width = width;
      loopStartCanvas.height = height;
      loopStartContext = loopStartCanvas.getContext("2d", { alpha: false });

      if (!loopStartContext) {
        throw new Error("The browser could not create the loop render surface.");
      }
    }

    const result = await encodeOfflineVideo({
      audioAnalysisTimeline,
      audioBuffer,
      bitrate,
      canvas: outputCanvas,
      durationSeconds,
      format: outputFormat,
      fps: frameRate,
      hardwareAcceleration,
      onProgress,
      signal,
      target: outputFile.target,
      renderFrame: ({
        audioSpectrum,
        frameDurationSeconds,
        frameIndex,
        timestampSeconds,
      }) => {
        throwIfVideoExportAborted(signal);
        writeSpectrumBands(audioSpectrum, shaderBands);
        const audioLevelForFrame = getSpectrumLevel(audioSpectrum);
        // The offline spectrum timeline already applies attack/release
        // smoothing. Snap it into the shader so the mesh and waveform use the
        // same frame and frame zero is not forced to silence.
        shaderRenderer?.setAudioTarget(
          shaderBands,
          audioLevelForFrame,
          true,
        );
        const rendered = shaderRenderer?.renderAt(
          mesh.frame + timestampSeconds * 1000 * mesh.speed,
          1000 / frameRate,
        );

        if (!rendered) {
          throw new Error(
            "The graphics context was lost while rendering the video.",
          );
        }

        outputContext.globalAlpha = 1;
        outputContext.globalCompositeOperation = "copy";
        outputContext.filter = "none";
        outputContext.drawImage(shaderCanvas, 0, 0, width, height);
        outputContext.globalCompositeOperation = "source-over";
        drawOverlay(outputContext, width, height, {
          audioLevel: audioLevelForFrame,
          audioSpectrum,
          image: overlayImage,
          overlay,
          qrImage,
          topLogoImage,
          waveformStyle,
          waveformTimestampSeconds:
            timestampSeconds + frameDurationSeconds / 2,
        });

        if (loopStartCanvas && loopStartContext && frameIndex === 0) {
          loopStartContext.drawImage(outputCanvas, 0, 0);
        } else if (loopStartCanvas) {
          const loopFade = getLoopFadeAmount(
            timestampSeconds * 1000,
            durationSeconds * 1000,
          );

          if (loopFade > 0) {
            outputContext.save();
            outputContext.globalAlpha = loopFade;
            outputContext.drawImage(loopStartCanvas, 0, 0);
            outputContext.restore();
          }
        }
      },
    });

    return await outputFile.finish(result.mimeType);
  } finally {
    shaderRenderer?.dispose();
    outputCanvas.width = 1;
    outputCanvas.height = 1;

    if (loopStartCanvas) {
      loopStartCanvas.width = 1;
      loopStartCanvas.height = 1;
    }
  }
}

function writeSpectrumBands(
  spectrum: ArrayLike<number>,
  output: Float32Array,
) {
  for (let bandIndex = 0; bandIndex < output.length; bandIndex += 1) {
    const start = Math.floor((bandIndex / output.length) * spectrum.length);
    const end = Math.max(
      start + 1,
      Math.floor(((bandIndex + 1) / output.length) * spectrum.length),
    );
    let total = 0;

    for (let spectrumIndex = start; spectrumIndex < end; spectrumIndex += 1) {
      total += spectrum[spectrumIndex] ?? 0;
    }

    output[bandIndex] = Math.max(
      0,
      Math.min(1, total / Math.max(1, end - start)),
    );
  }
}

function getSpectrumLevel(spectrum: ArrayLike<number>) {
  let total = 0;

  for (let index = 0; index < spectrum.length; index += 1) {
    total += spectrum[index] ?? 0;
  }

  return Math.max(0, Math.min(1, total / Math.max(1, spectrum.length)));
}

function getVideoFormatOverallProgress(
  formatIndex: number,
  formatProgress: number,
  totalFormats: number,
) {
  const normalizedFormatProgress =
    (Math.max(0, formatIndex) + Math.max(0, Math.min(1, formatProgress))) /
    Math.max(1, totalFormats);

  return (
    videoPreparationProgressWeight +
    normalizedFormatProgress * (1 - videoPreparationProgressWeight)
  );
}

function createThrottledProgressReporter(
  report: (progress: number) => void,
) {
  let lastProgress = -1;
  let lastReportedAt = -Infinity;

  return (progress: number) => {
    const clampedProgress = Math.max(0, Math.min(1, progress));
    const now = performance.now();

    if (
      clampedProgress >= 1 ||
      lastProgress < 0 ||
      clampedProgress - lastProgress >= 0.005 ||
      now - lastReportedAt >= 200
    ) {
      lastProgress = clampedProgress;
      lastReportedAt = now;
      report(clampedProgress);
    }
  };
}

function throwIfVideoExportAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("Video export cancelled.", "AbortError");
  }
}

function isAbortError(error: unknown) {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function getVideoExportErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return `Video export failed: ${error.message}`;
  }

  return "Video export failed because of an unknown browser error.";
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

function normalizeRenderMesh(meshToNormalize: MeshConfig): MeshConfig {
  return {
    ...normalizeMesh(meshToNormalize),
    frame: finiteNumber(meshToNormalize.frame, 0),
  };
}

function applyPresetAudioDefaults(meshToNormalize: MeshConfig): MeshConfig {
  return {
    ...meshToNormalize,
    audioReactivity: presetAudioReactivity,
    audioSmoothness: presetAudioSmoothness,
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

function getPreviewFrameClass(label: string) {
  if (label === "1:1") return "format-frame-square";
  if (label === "16:9") return "format-frame-16x9";
  if (label === "9:16") return "format-frame-9x16";
  if (label === "4:3") return "format-frame-4x3";
  if (label === "3:4") return "format-frame-3x4";
  return "format-frame-square";
}

function getRenderableOverlay(overlay: VisualOverlay): VisualOverlay {
  if (overlay.centerLogoOnly) {
    return {
      ...overlay,
      asset: "logo",
      centerLogoOnly: true,
      centerLogoSize: overlay.centerLogoSize,
      showBottomCta: false,
      showBottomLeftSlogan: false,
      showTopLogo: false,
    };
  }

  return {
    ...overlay,
    asset: "waveform",
    centerLogoOnly: false,
    centerLogoSize: overlay.centerLogoSize,
  };
}

function getCenterLogoSizePercent(overlay: VisualOverlay) {
  return overlay.centerLogoSize === "50" ? 50 : 33;
}

function formatSlug(formatToSlug: FormatConfig) {
  return formatToSlug.label.replace(":", "x").toLowerCase();
}

async function captureTargetPng(
  handle: ShaderStageHandle,
  scale: 1 | 2,
  format: FormatConfig,
  overlay: VisualOverlay,
  audioSpectrum: number[],
  audioLevel: number,
  overlayImage: HTMLImageElement | null,
  qrImage: HTMLImageElement | null,
  topLogoImage: HTMLImageElement | null,
  waveformStyle: WaveformStyle,
  frame: number,
  waveformTimestampSeconds: number,
) {
  const canvas = handle.getCanvas(frame);

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
  drawOverlay(context, exportCanvas.width, exportCanvas.height, {
    audioLevel,
    audioSpectrum,
    image: overlayImage,
    qrImage,
    topLogoImage,
    overlay,
    pixelScale: scale,
    waveformStyle,
    waveformTimestampSeconds,
  });

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
    audioSpectrum: ArrayLike<number>;
    image: HTMLImageElement | null;
    qrImage: HTMLImageElement | null;
    topLogoImage: HTMLImageElement | null;
    overlay: VisualOverlay;
    pixelScale?: number;
    waveformStyle: WaveformStyle;
    waveformTimestampSeconds?: number;
  },
) {
  const {
    audioLevel,
    audioSpectrum,
    image,
    qrImage,
    topLogoImage,
    overlay,
    pixelScale = 1,
    waveformStyle,
    waveformTimestampSeconds,
  } = options;
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
      waveformStyle,
      pixelScale,
      waveformTimestampSeconds,
    );
  } else if (image && overlay.asset !== "none") {
    const imageRatio = image.naturalWidth / image.naturalHeight;
    const maxWidth = overlay.asset === "star"
      ? width * 0.22
      : width * (overlay.centerLogoOnly ? getCenterLogoSizePercent(overlay) / 100 : 0.62);
    const maxHeight = overlay.asset === "star"
      ? height * 0.22
      : height * (overlay.centerLogoOnly ? getCenterLogoSizePercent(overlay) / 100 : 0.22);
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

  if (
    !overlay.centerLogoOnly &&
    (overlay.showTopLogo || overlay.showBottomLeftSlogan || overlay.showBottomCta)
  ) {
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
  audioSpectrum: ArrayLike<number>,
  color: string,
  waveformStyle: WaveformStyle,
  pixelScale = 1,
  timestampSeconds?: number,
) {
  const style = getWaveformStyle(waveformStyle);
  const bars = createWaveformBars(
    audioSpectrum,
    style,
    {
      barCount: getWaveformBarCount(width, height),
      timestampSeconds,
    },
  );
  const peakHeightRatio = Math.max(
    0,
    ...bars.map((bar) => bar.heightRatio),
  );
  const edgeBlurRadius =
    Math.min(width, height) * WAVEFORM_EDGE_BLUR_MAX_RATIO;
  const glowBlurRadius =
    Math.min(width, height) * WAVEFORM_GLOW_BLUR_MAX_RATIO;
  const sceneWaveBounds = getSceneWaveBounds(
    width,
    height,
    style,
    peakHeightRatio,
    edgeBlurRadius,
    pixelScale,
  );
  const overlayWidth = sceneWaveBounds.width;
  const overlayHeight = sceneWaveBounds.height;
  const waveformAmplitudeScale = sceneWaveBounds.amplitudeScale;
  const left = (width - overlayWidth) / 2;
  const top = (height - overlayHeight) / 2;
  const barStep = sceneWaveBounds.barStep;
  const barWidth = sceneWaveBounds.barWidth;
  const barCenterInset = sceneWaveBounds.barCenterInset;
  const barPixelScale = sceneWaveBounds.pixelScale;

  drawWaveformGlowLayer(
    context,
    bars,
    color,
    width,
    height,
    left,
    top + overlayHeight / 2,
    overlayWidth,
    overlayHeight,
    waveformAmplitudeScale,
    barWidth,
    barCenterInset,
    barStep,
    barPixelScale,
    edgeBlurRadius,
    glowBlurRadius,
  );

  drawWaveformBlurLayer(
    context,
    bars,
    color,
    width,
    height,
    left,
    top + overlayHeight / 2,
    overlayWidth,
    overlayHeight,
    waveformAmplitudeScale,
    barWidth,
    barCenterInset,
    barStep,
    barPixelScale,
    edgeBlurRadius,
  );

  context.fillStyle = color;
  context.filter = "none";

  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    const barHeight = getWaveformRenderedBarHeight(
      bar?.heightRatio ?? 0,
      overlayHeight,
      waveformAmplitudeScale,
      barWidth,
    );
    const renderedBarWidth = getWaveformRenderedBarWidth(
      barHeight,
      barWidth,
    );
    const opacity = bar
      ? getWaveformBarLayerOpacities(bar).sharpOpacity *
        getWaveformRenderedBarOpacityScale(
          bar.heightRatio,
          overlayHeight,
          waveformAmplitudeScale,
          barWidth,
        )
      : 0;
    const centerOffset = bar
      ? getWaveformRenderedBarCenterOffset(
          bar.centerOffsetRatio,
          overlayHeight,
          waveformAmplitudeScale,
        )
      : 0;

    if (
      barHeight <= 0 ||
      renderedBarWidth <= 0 ||
      opacity <= 0
    ) {
      continue;
    }

    const x =
      left +
      getWaveformBarOffset(index, barStep, barPixelScale) +
      barCenterInset -
      renderedBarWidth / 2;
    const y =
      top + (overlayHeight - barHeight) / 2 + centerOffset;
    drawWaveformCoreBar(
      context,
      x,
      y,
      renderedBarWidth,
      barHeight,
      color,
      opacity,
    );
  }

  context.globalAlpha = 1;
  context.filter = "none";
}

function drawWaveformGlowLayer(
  context: CanvasRenderingContext2D,
  bars: ReturnType<typeof createWaveformBars>,
  color: string,
  frameWidth: number,
  frameHeight: number,
  left: number,
  centerY: number,
  overlayWidth: number,
  overlayHeight: number,
  amplitudeScale: number,
  barWidth: number,
  barCenterInset: number,
  barStep: number,
  barPixelScale: number,
  edgeBlurRadius: number,
  glowBlurRadius: number,
) {
  if (glowBlurRadius <= 0) {
    return;
  }

  const maxGlowHeight = getWaveformMaxPeakHeight(
    frameWidth,
    frameHeight,
    edgeBlurRadius,
  );
  const pad = Math.ceil(glowBlurRadius * 3);
  const layerLeft = Math.floor(left - pad);
  const layerTop = Math.floor(centerY - maxGlowHeight / 2 - pad);
  const layerRight = Math.ceil(left + overlayWidth + pad);
  const layerBottom = Math.ceil(centerY + maxGlowHeight / 2 + pad);
  const layerWidth = Math.max(1, layerRight - layerLeft);
  const layerHeight = Math.max(1, layerBottom - layerTop);
  let layer = waveformGlowLayerCache.get(context);

  if (!layer) {
    const canvas = document.createElement("canvas");
    const layerContext = canvas.getContext("2d");

    if (!layerContext) {
      return;
    }

    const sprite = document.createElement("canvas");
    sprite.width = 8;
    sprite.height = 256;
    layer = { canvas, color: "", context: layerContext, sprite };
    waveformGlowLayerCache.set(context, layer);
  }

  const { canvas, context: layerContext, sprite } = layer;

  if (canvas.width !== layerWidth || canvas.height !== layerHeight) {
    canvas.width = layerWidth;
    canvas.height = layerHeight;
  }

  layerContext.setTransform(1, 0, 0, 1, 0, 0);
  layerContext.clearRect(0, 0, layerWidth, layerHeight);
  layerContext.filter = "none";
  layerContext.globalCompositeOperation = "source-over";

  if (layer.color !== color) {
    const spriteContext = sprite.getContext("2d");

    if (!spriteContext) {
      return;
    }

    const gradient = spriteContext.createLinearGradient(
      0,
      0,
      0,
      sprite.height,
    );

    gradient.addColorStop(0, "transparent");
    gradient.addColorStop(0.08, colorWithAlpha(color, 0.15625));
    gradient.addColorStop(0.16, colorWithAlpha(color, 0.5));
    gradient.addColorStop(0.24, colorWithAlpha(color, 0.84375));
    gradient.addColorStop(0.32, color);
    gradient.addColorStop(0.68, color);
    gradient.addColorStop(0.76, colorWithAlpha(color, 0.84375));
    gradient.addColorStop(0.84, colorWithAlpha(color, 0.5));
    gradient.addColorStop(0.92, colorWithAlpha(color, 0.15625));
    gradient.addColorStop(1, "transparent");
    spriteContext.clearRect(0, 0, sprite.width, sprite.height);
    spriteContext.fillStyle = gradient;
    spriteContext.fillRect(0, 0, sprite.width, sprite.height);
    layer.color = color;
  }

  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    const barHeight = getWaveformRenderedBarHeight(
      bar.heightRatio,
      overlayHeight,
      amplitudeScale,
      barWidth,
    );
    const renderedBarWidth = getWaveformRenderedBarWidth(
      barHeight,
      barWidth,
    );
    const activityOpacity = getWaveformRenderedBarOpacityScale(
      bar.heightRatio,
      overlayHeight,
      amplitudeScale,
      barWidth,
    );
    const glowHeight = getWaveformGlowHeight(
      barHeight,
      overlayHeight,
      activityOpacity,
      maxGlowHeight,
    );
    const opacity = getWaveformBarGlowOpacity(
      bar,
      activityOpacity,
    );
    const centerOffset = getWaveformRenderedBarCenterOffset(
      bar.centerOffsetRatio,
      overlayHeight,
      amplitudeScale,
    );

    if (
      glowHeight <= 0 ||
      renderedBarWidth <= 0 ||
      opacity <= 0
    ) {
      continue;
    }

    const x =
      left +
      getWaveformBarOffset(index, barStep, barPixelScale) +
      barCenterInset -
      renderedBarWidth / 2 -
      layerLeft;
    const y =
      centerY + centerOffset - glowHeight / 2 - layerTop;
    layerContext.globalAlpha = opacity;
    layerContext.drawImage(
      sprite,
      x,
      y,
      renderedBarWidth,
      glowHeight,
    );
  }

  layerContext.globalAlpha = 1;
  context.save();
  context.globalAlpha = 1;
  context.filter = `blur(${glowBlurRadius}px)`;
  context.drawImage(canvas, layerLeft, layerTop);
  context.restore();
}

function colorWithAlpha(color: string, alpha: number) {
  const normalized = color.replace("#", "");
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  const safeAlpha = Math.max(0, Math.min(1, alpha));

  return `rgb(${red} ${green} ${blue} / ${safeAlpha})`;
}

function drawWaveformCoreBar(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
  opacity: number,
) {
  context.fillStyle = color;
  context.globalAlpha = opacity;
  drawRoundedRect(
    context,
    x,
    y,
    width,
    height,
    width / 2,
  );
  context.fill();
}

function drawWaveformBlurLayer(
  context: CanvasRenderingContext2D,
  bars: ReturnType<typeof createWaveformBars>,
  color: string,
  frameWidth: number,
  frameHeight: number,
  left: number,
  centerY: number,
  overlayWidth: number,
  overlayHeight: number,
  amplitudeScale: number,
  barWidth: number,
  barCenterInset: number,
  barStep: number,
  barPixelScale: number,
  blurRadius: number,
) {
  const maxBarHeight = bars.reduce(
    (peak, bar) =>
      Math.max(
        peak,
        getWaveformRenderedBarHeight(
          bar.heightRatio,
          overlayHeight,
          amplitudeScale,
          barWidth,
        ),
      ),
    0,
  );

  if (maxBarHeight <= 0 || blurRadius <= 0) {
    return;
  }

  const pad = Math.ceil(blurRadius * 3);
  const maxSafeBarHeight = getWaveformMaxPeakHeight(
    frameWidth,
    frameHeight,
    blurRadius,
  );
  const layerLeft = Math.floor(left - pad);
  const layerTop = Math.floor(centerY - maxSafeBarHeight / 2 - pad);
  const layerRight = Math.ceil(left + overlayWidth + pad);
  const layerBottom = Math.ceil(centerY + maxSafeBarHeight / 2 + pad);
  const layerWidth = Math.max(1, layerRight - layerLeft);
  const layerHeight = Math.max(1, layerBottom - layerTop);
  let layer = waveformBlurLayerCache.get(context);

  if (!layer) {
    const canvas = document.createElement("canvas");
    const layerContext = canvas.getContext("2d");

    if (!layerContext) {
      return;
    }

    layer = { canvas, context: layerContext };
    waveformBlurLayerCache.set(context, layer);
  }

  const { canvas, context: layerContext } = layer;

  if (canvas.width !== layerWidth || canvas.height !== layerHeight) {
    canvas.width = layerWidth;
    canvas.height = layerHeight;
  }

  layerContext.setTransform(1, 0, 0, 1, 0, 0);
  layerContext.clearRect(0, 0, layerWidth, layerHeight);
  layerContext.filter = "none";
  layerContext.fillStyle = color;
  layerContext.globalCompositeOperation = "source-over";

  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    const barHeight = getWaveformRenderedBarHeight(
      bar.heightRatio,
      overlayHeight,
      amplitudeScale,
      barWidth,
    );
    const renderedBarWidth = getWaveformRenderedBarWidth(
      barHeight,
      barWidth,
    );
    const opacity =
      getWaveformBarLayerOpacities(bar).blurOpacity *
      getWaveformRenderedBarOpacityScale(
        bar.heightRatio,
        overlayHeight,
        amplitudeScale,
        barWidth,
      );
    const centerOffset = getWaveformRenderedBarCenterOffset(
      bar.centerOffsetRatio,
      overlayHeight,
      amplitudeScale,
    );

    if (
      barHeight <= 0 ||
      renderedBarWidth <= 0 ||
      opacity <= 0
    ) {
      continue;
    }

    const x =
      left +
      getWaveformBarOffset(index, barStep, barPixelScale) -
      layerLeft +
      barCenterInset -
      renderedBarWidth / 2;
    const y =
      centerY + centerOffset - barHeight / 2 - layerTop;
    drawWaveformCoreBar(
      layerContext,
      x,
      y,
      renderedBarWidth,
      barHeight,
      color,
      opacity,
    );
  }

  layerContext.globalAlpha = 1;
  context.save();
  context.globalAlpha = 1;
  context.filter = `blur(${blurRadius}px)`;
  context.drawImage(canvas, layerLeft, layerTop);
  context.restore();
}

function getSceneWaveBounds(
  width: number,
  height: number,
  waveformStyle: WaveformStyle = getWaveformStyle(),
  peakHeightRatio = 0,
  edgeBlurRadius = 0,
  pixelScale = 1,
) {
  const geometry = getWaveformGeometry(
    width,
    height,
    waveformStyle.boxScale,
    pixelScale,
  );

  return {
    amplitudeScale: getWaveformAmplitudeScale(
      width,
      height,
      geometry.height,
      peakHeightRatio,
      WAVEFORM_AMPLITUDE_SCALE,
      edgeBlurRadius,
    ),
    ...geometry,
  };
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
  const margin = getSceneHorizontalPadding(width);
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

  let cachedSnapshot = blurredBackdropCache.get(context);

  if (!cachedSnapshot) {
    const canvas = document.createElement("canvas");
    const snapshotContext = canvas.getContext("2d");

    if (!snapshotContext) {
      return;
    }

    cachedSnapshot = {
      canvas,
      context: snapshotContext,
    };
    blurredBackdropCache.set(context, cachedSnapshot);
  }

  const { canvas: snapshot, context: snapshotContext } = cachedSnapshot;

  if (snapshot.width !== sw || snapshot.height !== sh) {
    snapshot.width = sw;
    snapshot.height = sh;
  }

  snapshotContext.clearRect(0, 0, sw, sh);
  snapshotContext.filter = "none";
  snapshotContext.globalAlpha = 1;
  snapshotContext.globalCompositeOperation = "copy";
  snapshotContext.drawImage(context.canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  snapshotContext.globalCompositeOperation = "source-over";
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

async function readGalleryState(): Promise<GalleryDocument> {
  const apiGalleryState = await fetchGalleryState(galleryApiPath, true);

  if (apiGalleryState) {
    return apiGalleryState;
  }

  const staticGalleryState = await fetchGalleryState(staticGalleryPath, false);

  if (staticGalleryState) {
    return staticGalleryState;
  }

  throw new Error("Gallery file could not be loaded.");
}

async function writeGalleryState(
  state: GalleryState,
  revision: string | null,
  baseState: GalleryState,
): Promise<GalleryWriteResult> {
  let nextState = state;
  let nextRevision = revision;
  let nextBaseState = baseState;

  if (nextRevision === null) {
    writeLegacyGalleryState(nextState);
    return { revision: null, state: nextState };
  }

  for (let attempt = 0; attempt < galleryConflictRetryLimit; attempt += 1) {
    let response: Response;

    try {
      response = await fetch(galleryApiPath, {
        body: JSON.stringify(nextState),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "If-Match": nextRevision,
        },
        method: "PUT",
      });
    } catch {
      throw new Error("Gallery server could not be reached.");
    }

    if (response.ok) {
      const savedRevision = response.headers.get("ETag");

      if (!savedRevision) {
        throw new Error("Gallery server did not return a revision.");
      }

      const responseBody = await readJsonResponse(response);
      const savedState =
        isRecord(responseBody) && isGalleryStatePayload(responseBody.state)
          ? normalizeGalleryState(responseBody.state)
          : nextState;

      return { revision: savedRevision, state: savedState };
    }

    if (response.status !== 409) {
      const responseBody = await readJsonResponse(response);
      const message =
        isRecord(responseBody) && typeof responseBody.error === "string"
          ? responseBody.error
          : `Gallery save failed with status ${response.status}.`;

      throw new Error(message);
    }

    const conflictBody = await readJsonResponse(response);
    const remoteRevision = response.headers.get("ETag");
    const remoteStateValue =
      isRecord(conflictBody) && "state" in conflictBody
        ? conflictBody.state
        : null;

    if (!remoteRevision || !isGalleryStatePayload(remoteStateValue)) {
      throw new Error("Gallery conflict response was invalid.");
    }

    const remoteState = normalizeGalleryState(remoteStateValue);
    nextState = mergeConcurrentGalleryStates(
      nextBaseState,
      nextState,
      remoteState,
    );
    nextBaseState = remoteState;
    nextRevision = remoteRevision;
  }

  throw new Error("Gallery changed repeatedly while it was being saved.");
}

async function fetchGalleryState(
  path: string,
  requiresRevision: boolean,
): Promise<GalleryDocument | null> {
  try {
    const response = await fetch(path, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      return null;
    }

    const value = await response.json();
    const revision = requiresRevision ? response.headers.get("ETag") : null;

    if (!isGalleryStatePayload(value) || (requiresRevision && !revision)) {
      return null;
    }

    return {
      revision,
      state: normalizeGalleryState(value),
    };
  } catch {
    return null;
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
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

function writeLegacyGalleryState(state: GalleryState) {
  if (typeof window === "undefined") {
    throw new Error("Gallery file could not be saved.");
  }

  window.localStorage.setItem(
    legacyGalleryStorageKey,
    JSON.stringify(normalizeGalleryState(state)),
  );
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

function mergeConcurrentGalleryStates(
  baseState: GalleryState,
  localState: GalleryState,
  remoteState: GalleryState,
): GalleryState {
  const baseSections = new Map(
    baseState.sections.map((section) => [section.id, section]),
  );
  const remoteSections = new Map(
    remoteState.sections.map((section) => [section.id, section]),
  );
  const mergedSections: GallerySection[] = [];
  const mergedSectionIds = new Set<string>();

  localState.sections.forEach((localSection) => {
    if (mergedSectionIds.has(localSection.id)) {
      return;
    }

    const baseSection = baseSections.get(localSection.id);
    const remoteSection = remoteSections.get(localSection.id);
    const mergedSection =
      baseSection && remoteSection
        ? {
            ...remoteSection,
            isOpen:
              localSection.isOpen !== baseSection.isOpen
                ? localSection.isOpen
                : remoteSection.isOpen,
            name:
              localSection.name !== baseSection.name
                ? localSection.name
                : remoteSection.name,
          }
        : localSection;

    mergedSections.push(mergedSection);
    mergedSectionIds.add(mergedSection.id);
  });

  remoteState.sections.forEach((remoteSection) => {
    if (!mergedSectionIds.has(remoteSection.id)) {
      mergedSections.push(remoteSection);
      mergedSectionIds.add(remoteSection.id);
    }
  });

  const baseItems = new Map(baseState.items.map((item) => [item.id, item]));
  const remoteItems = new Map(remoteState.items.map((item) => [item.id, item]));
  const mergedItems: VisualSnapshot[] = [];
  const mergedItemIds = new Set<string>();

  localState.items.forEach((localItem) => {
    if (mergedItemIds.has(localItem.id)) {
      return;
    }

    const baseItem = baseItems.get(localItem.id);
    const remoteItem = remoteItems.get(localItem.id);
    const mergedItem =
      baseItem && remoteItem
        ? {
            ...remoteItem,
            sectionId:
              localItem.sectionId !== baseItem.sectionId
                ? localItem.sectionId
                : remoteItem.sectionId,
          }
        : localItem;

    mergedItems.push(mergedItem);
    mergedItemIds.add(mergedItem.id);
  });

  remoteState.items.forEach((remoteItem) => {
    if (!mergedItemIds.has(remoteItem.id)) {
      mergedItems.push(remoteItem);
      mergedItemIds.add(remoteItem.id);
    }
  });

  return normalizeGalleryState({
    items: mergedItems,
    sections: mergedSections,
  });
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
  const renderVersion = value.renderVersion === 2 ? 2 : 1;

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
    // Unversioned gallery items were authored against the legacy 0–500k
    // timeline and were always clamped on load. Preserve that phase exactly,
    // while version 2 snapshots retain the unbounded timeline.
    mesh: applyPresetAudioDefaults(
      renderVersion === 2
        ? normalizeRenderMesh(value.mesh as MeshConfig)
        : normalizeMesh(value.mesh as MeshConfig),
    ),
    name: value.name,
    overlay: normalizeOverlay(value.overlay),
    renderVersion,
    sectionId,
    thumbnail: value.thumbnail,
  };
}

function normalizeOverlay(value: unknown): VisualOverlay {
  if (!isRecord(value)) {
    return { ...defaultVisualOverlay };
  }

  const centerLogoOnly =
    typeof value.centerLogoOnly === "boolean"
      ? value.centerLogoOnly
      : defaultVisualOverlay.centerLogoOnly;
  const asset = centerLogoOnly ? "logo" : "waveform";
  const centerLogoSize =
    value.centerLogoSize === "33" || value.centerLogoSize === "50"
      ? value.centerLogoSize
      : defaultVisualOverlay.centerLogoSize;
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

  return {
    asset,
    bottomRight,
    centerLogoOnly,
    centerLogoSize,
    showBottomCta,
    showBottomLeftSlogan,
    showTopLogo,
    tone,
  };
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

function isGalleryStatePayload(
  value: unknown,
): value is { items: unknown[]; sections: unknown[] } {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    Array.isArray(value.sections)
  );
}

function finiteNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function createRandomWaveformStyle(): WaveformStyle {
  const profiles = [
    () => getWaveformStyle({
      bellBoost: randomBetween(1.2, 2),
      boxScale: randomBetween(0.82, 1.08),
      centerEnvelopePower: randomBetween(2.4, 4),
      centerGain: randomBetween(2, 3.8),
      edgeGain: randomBetween(0.35, 0.8),
      noiseFloor: randomBetween(0, 0.045),
      sideFloor: randomBetween(0.02, 0.14),
      sideMotionMix: randomBetween(0, 0.14),
      verticalGain: randomBetween(1.2, 2.3),
      widthFactor: randomBetween(0.56, 0.9),
    }),
    () => getWaveformStyle({
      bellBoost: randomBetween(0.1, 0.9),
      boxScale: randomBetween(1.02, 1.28),
      centerEnvelopePower: randomBetween(0.75, 1.55),
      centerGain: randomBetween(1.15, 2.15),
      edgeGain: randomBetween(1.0, 2.35),
      noiseFloor: randomBetween(0, 0.035),
      sideFloor: randomBetween(0.28, 0.62),
      sideMotionMix: randomBetween(0.42, 0.85),
      verticalGain: randomBetween(0.75, 1.65),
      widthFactor: randomBetween(1.02, 1.45),
    }),
    () => getWaveformStyle({
      bellBoost: randomBetween(0.8, 1.8),
      boxScale: randomBetween(0.9, 1.18),
      centerEnvelopePower: randomBetween(1.2, 2.8),
      centerGain: randomBetween(1.55, 3.25),
      edgeGain: randomBetween(0.7, 1.65),
      noiseFloor: randomBetween(0, 0.06),
      sideFloor: randomBetween(0.12, 0.35),
      sideMotionMix: randomBetween(0.16, 0.46),
      verticalGain: randomBetween(1.15, 2.45),
      widthFactor: randomBetween(0.78, 1.22),
    }),
    () => getWaveformStyle({
      bellBoost: randomBetween(1.5, 2),
      boxScale: randomBetween(0.76, 1.06),
      centerEnvelopePower: randomBetween(3.2, 4),
      centerGain: randomBetween(2.4, 4),
      edgeGain: randomBetween(0.18, 0.62),
      noiseFloor: randomBetween(0.015, 0.08),
      sideFloor: randomBetween(0, 0.08),
      sideMotionMix: randomBetween(0, 0.08),
      verticalGain: randomBetween(1.4, 2.5),
      widthFactor: randomBetween(0.7, 1.12),
    }),
  ];
  const profile = profiles[Math.floor(Math.random() * profiles.length)] ?? profiles[0];

  return profile();
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


export default App;
