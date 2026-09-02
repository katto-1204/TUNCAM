import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  AlertTriangle, Archive, BadgeCheck, BoxSelect, Camera, Check, ChevronDown, ChevronLeft,
  ClipboardList, CloudOff, Contrast, Download, Eye, EyeOff, FileImage, FileUp, FolderOpen,
  Image as ImageIcon, Info, Keyboard, LaptopMinimal, Loader2, MonitorDown, Pause, PenLine, Plus, RefreshCw, RotateCcw, RotateCw,
  ScanLine, Settings2, ShieldCheck, SlidersHorizontal, Sun, Trash2, Move,
  Undo2, Upload, UserRound, Video, X, Zap,
} from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { type BboxAnnotation, noteAnnotations, parseBboxAnnotations, serializeBboxAnnotation } from '@/lib/annotations';
import {
  DIFFERENTIAL_NOTES, GRADE_TIER_LABEL, determinantsByCategory, type Determinant,
} from '@/lib/determinants';
import {
  buildFilename, datasetZipName, defaultSettings, exampleFilename, exportGuideText, gradeCode, gradeColors,
  gradeLabels, grades, jpegFilename, manifestCsv, manifestJson, photoZipPath, recordPath, sampleCode, siteCode, today,
  type Grade, type RecordItem, type SampleType, type SessionSettings, triggerDownload,
} from '@/lib/dataset';
import { deleteRelativeFile, ensureFolderPermission, FolderAccessError, pickSessionFolder, writeRelativeFile } from '@/lib/local-folder';
import { importSessionZip } from '@/lib/session-import';
import { clearSession, getAllImages, getImage, listRecords, loadDirectoryHandle, migrateLegacyRecords, putRecord, removeRecord, saveDirectoryHandle, updateRecord } from '@/lib/session-store';
import { buildZip, type ZipEntry } from '@/lib/zip';
import {
  adjustmentsToCssFilter, BRIGHT_OVERHEAD_PRESET, DEFAULT_IMAGE_ADJUSTMENTS, HUMAN_EYE_PRESET,
  INDOOR_WARM_PRESET, isDefaultAdjustments, loadImageAdjustments, saveImageAdjustments, type ImageAdjustments,
} from '@/lib/image-adjustments';

const queryClient = new QueryClient();
const SETTINGS_KEY = 'tuncam-session-settings-v1';
const PREVIEW_STORAGE_KEY = 'tuncam-preview-urls-v1'; // legacy — cleared on boot; previews live in IndexedDB
const CAMERA_TIMEOUT_MS = 12_000;

type CameraState = 'idle' | 'loading' | 'ready' | 'denied' | 'missing' | 'timeout';
type ChamberGuide = 'framing' | 'rotation';
type ToastItem = { id: number; message: string; tone?: 'info' | 'success' | 'warning' | 'error' };
type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

const ROTATION_LABELS = ['Side 1', 'Side 2', 'Side 3', 'Side 4', 'Side 5', 'Side 6'] as const;
const ROTATION_PIE_SETTINGS_KEY = 'tuncam-rotation-pie-settings-v1';
const FRAMING_CROSSHAIR_KEY = 'tuncam-framing-crosshair-v1';
const FRAMING_CROSSHAIR_BAR_KEY = 'tuncam-framing-crosshair-bar-open-v1';
const PROGRESS_TARGET = 800;

type FramingCrosshairStyle = 'none' | 'classic' | 'gap' | 'reticle' | 'thirds' | 'square' | 'mil';

const FRAMING_CROSSHAIR_STYLES: FramingCrosshairStyle[] = [
  'none', 'classic', 'gap', 'reticle', 'thirds', 'square', 'mil',
];

const FRAMING_CROSSHAIR_LABELS: Record<FramingCrosshairStyle, string> = {
  none: 'Off',
  classic: 'Cross',
  gap: 'Gap',
  reticle: 'Ring',
  thirds: '3rd',
  square: 'Box',
  mil: 'Mil',
};

const FRAMING_FRAME = { l: 10, r: 90, t: 12, b: 88 } as const;

function FramingCrosshairGraphics({ style }: { style: FramingCrosshairStyle }) {
  const line = 'rgba(255,255,255,.4)';
  const soft = 'rgba(255,255,255,.22)';
  const accent = '#8BA4FF';
  const { l, r, t, b } = FRAMING_FRAME;
  const cx = 50;
  const cy = 50;

  const hLine = (y: number, x1 = l, x2 = r, color = line, width = 0.26) => (
    <line key={`h-${y}`} x1={x1} y1={y} x2={x2} y2={y} stroke={color} strokeWidth={width} vectorEffect="non-scaling-stroke" />
  );
  const vLine = (x: number, y1 = t, y2 = b, color = line, width = 0.26) => (
    <line key={`v-${x}`} x1={x} y1={y1} x2={x} y2={y2} stroke={color} strokeWidth={width} vectorEffect="non-scaling-stroke" />
  );
  const gapArm = (x1: number, y1: number, x2: number, y2: number, width = 0.28) => (
    <line key={`g-${x1}-${y1}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={line} strokeWidth={width} vectorEffect="non-scaling-stroke" />
  );

  if (style === 'none') return null;

  return (
    <svg className="pointer-events-none absolute inset-0 size-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
      {style === 'classic' && (
        <>
          {hLine(cy, l, r)}
          {vLine(cx, t, b)}
        </>
      )}
      {style === 'gap' && (
        <>
          {gapArm(l, cy, 44, cy)}
          {gapArm(56, cy, r, cy)}
          {gapArm(cx, t, cx, 44)}
          {gapArm(cx, 56, cx, b)}
        </>
      )}
      {style === 'reticle' && (
        <>
          <circle cx={cx} cy={cy} r="7.2" fill="none" stroke={accent} strokeWidth="0.34" vectorEffect="non-scaling-stroke" opacity="0.9" />
          <circle cx={cx} cy={cy} r="1.8" fill="none" stroke={line} strokeWidth="0.24" vectorEffect="non-scaling-stroke" />
          {gapArm(l, cy, 41, cy, 0.24)}
          {gapArm(59, cy, r, cy, 0.24)}
          {gapArm(cx, t, cx, 41, 0.24)}
          {gapArm(cx, 59, cx, b, 0.24)}
        </>
      )}
      {style === 'thirds' && (
        <>
          {vLine(l + (r - l) / 3)}
          {vLine(l + ((r - l) * 2) / 3)}
          {hLine(t + (b - t) / 3)}
          {hLine(t + ((b - t) * 2) / 3)}
        </>
      )}
      {style === 'square' && (
        <>
          <rect x="40" y="42" width="20" height="16" fill="none" stroke={accent} strokeWidth="0.34" vectorEffect="non-scaling-stroke" opacity="0.92" />
          {hLine(cy, 40, 60, soft, 0.2)}
          {vLine(cx, 42, 58, soft, 0.2)}
        </>
      )}
      {style === 'mil' && (
        <>
          {gapArm(l, cy, 38, cy, 0.26)}
          {gapArm(62, cy, r, cy, 0.26)}
          {gapArm(cx, t, cx, 38, 0.26)}
          {gapArm(cx, 62, cx, b, 0.26)}
          {[36, 40, 44, 56, 60, 64].map((x) => (
            <line key={`tx-${x}`} x1={x} y1={cy - 0.8} x2={x} y2={cy + 0.8} stroke={soft} strokeWidth="0.2" vectorEffect="non-scaling-stroke" />
          ))}
          {[38, 42, 46, 54, 58, 62].map((y) => (
            <line key={`ty-${y}`} x1={cx - 0.8} y1={y} x2={cx + 0.8} y2={y} stroke={soft} strokeWidth="0.2" vectorEffect="non-scaling-stroke" />
          ))}
        </>
      )}
    </svg>
  );
}

function loadFramingCrosshairBarOpen(): boolean {
  try {
    return localStorage.getItem(FRAMING_CROSSHAIR_BAR_KEY) !== '0';
  } catch { /* ignore */ }
  return true;
}

function loadFramingCrosshair(): FramingCrosshairStyle {
  try {
    const raw = localStorage.getItem(FRAMING_CROSSHAIR_KEY);
    if (raw && FRAMING_CROSSHAIR_STYLES.includes(raw as FramingCrosshairStyle)) {
      return raw as FramingCrosshairStyle;
    }
  } catch { /* ignore */ }
  return 'classic';
}

type RotationPieSettings = {
  scale: number;
  rotation: number;
  offsetX: number;
  offsetY: number;
  dim: number;
  hidePlaceholders: boolean;
};

const DEFAULT_ROTATION_PIE_SETTINGS: RotationPieSettings = {
  scale: 0.9,
  rotation: 0,
  offsetX: 0,
  offsetY: 0,
  dim: 0.55,
  hidePlaceholders: false,
};

function loadRotationPieSettings(): RotationPieSettings {
  try {
    const raw = localStorage.getItem(ROTATION_PIE_SETTINGS_KEY);
    if (!raw) return DEFAULT_ROTATION_PIE_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<RotationPieSettings>;
    return { ...DEFAULT_ROTATION_PIE_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_ROTATION_PIE_SETTINGS;
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ErrorBoundary>
          <Tuncam />
        </ErrorBoundary>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function Tuncam() {
  const [settings, setSettings] = useState<SessionSettings>(() => {
    try { return { ...defaultSettings, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { return defaultSettings; }
  });
  const [customSite, setCustomSite] = useState('');
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [cameraState, setCameraState] = useState<CameraState>('idle');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDevice, setSelectedDevice] = useState('');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [cameraIssue, setCameraIssue] = useState('');
  const [capturedBlob, setCapturedBlob] = useState<Blob | undefined>();
  const [capturedPreview, setCapturedPreview] = useState<string | undefined>();
  const [isGradeOpen, setIsGradeOpen] = useState(false);
  const [isReviewOpen, setIsReviewOpen] = useState(false);
  const [isEndOpen, setIsEndOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isShortcutOpen, setIsShortcutOpen] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isOverriding, setIsOverriding] = useState(false);
  const [isTypeOverriding, setIsTypeOverriding] = useState(false);
  const [importDragOver, setImportDragOver] = useState(false);
  const [lastImport, setLastImport] = useState<{ name: string; added: number; duplicates: number; missingImages: number } | null>(null);
  const [isAwake, setIsAwake] = useState(false);
  const [wakeSupport, setWakeSupport] = useState<'unknown' | 'supported' | 'unsupported'>('unknown');
  const [folderChosen, setFolderChosen] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [gradeError, setGradeError] = useState('');
  const [chamberGuide, setChamberGuide] = useState<ChamberGuide>('framing');
  const [rotationSlices, setRotationSlices] = useState<boolean[]>(() => Array(6).fill(false));
  const [currentRotation, setCurrentRotation] = useState(0);
  const [rotationPieSettings, setRotationPieSettings] = useState(loadRotationPieSettings);
  const [framingCrosshair, setFramingCrosshair] = useState<FramingCrosshairStyle>(loadFramingCrosshair);
  const [imageAdjustments, setImageAdjustments] = useState(loadImageAdjustments);
  const [isVisionAdjustOpen, setIsVisionAdjustOpen] = useState(false);
  const [isNewSamplePromptOpen, setIsNewSamplePromptOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chamberRef = useRef<HTMLElement>(null);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  const folderRef = useRef<FileSystemDirectoryHandle | null>(null);
  const toastId = useRef(1);
  const previewUrls = useRef<Record<string, string>>({});
  const cameraTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const notify = useCallback((message: string, tone: ToastItem['tone'] = 'info') => {
    const id = toastId.current++;
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 4200);
  }, []);

  const updateRotationPieSettings = useCallback((patch: Partial<RotationPieSettings>) => {
    setRotationPieSettings((current) => {
      const next = { ...current, ...patch };
      try { localStorage.setItem(ROTATION_PIE_SETTINGS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const updateFramingCrosshair = useCallback((style: FramingCrosshairStyle) => {
    setFramingCrosshair(style);
    try { localStorage.setItem(FRAMING_CROSSHAIR_KEY, style); } catch { /* ignore */ }
  }, []);

  const updateImageAdjustments = useCallback((patch: Partial<ImageAdjustments>) => {
    setImageAdjustments((current) => {
      const next = { ...current, ...patch };
      saveImageAdjustments(next);
      return next;
    });
  }, []);

  const applyImageAdjustments = useCallback((next: ImageAdjustments) => {
    saveImageAdjustments(next);
    setImageAdjustments(next);
  }, []);

  const visionFilter = useMemo(() => adjustmentsToCssFilter(imageAdjustments), [imageAdjustments]);

  const rememberPreview = useCallback((id: string, url: string) => {
    if (previewUrls.current[id]) URL.revokeObjectURL(previewUrls.current[id]);
    previewUrls.current[id] = url;
    setPreviews({ ...previewUrls.current });
  }, []);

  const forgetPreview = useCallback((id: string) => {
    if (previewUrls.current[id]) {
      URL.revokeObjectURL(previewUrls.current[id]);
      delete previewUrls.current[id];
      setPreviews({ ...previewUrls.current });
    }
  }, []);

  const connectCamera = useCallback(async (deviceId = selectedDevice, retryLowRes = false) => {
    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
      setCameraState('missing');
      setCameraIssue('Camera access requires HTTPS or localhost. Open the published PWA or use localhost, then press Connect camera.');
      return;
    }

    setCameraState('loading');
    setCameraIssue('');
    setVideoReady(false);

    // Set a timeout for camera connection
    if (cameraTimeoutRef.current) clearTimeout(cameraTimeoutRef.current);
    cameraTimeoutRef.current = setTimeout(() => {
      setCameraState((current) => {
        if (current === 'loading') {
          setCameraIssue('Camera is taking too long to respond. Make sure the webcam is connected, not in use by another app, and try again.');
          return 'timeout';
        }
        return current;
      });
    }, CAMERA_TIMEOUT_MS);

    try {
      const videoConstraints: MediaTrackConstraints = retryLowRes
        ? {
            width: { ideal: 640 },
            height: { ideal: 480 },
            facingMode: deviceId ? undefined : { ideal: 'environment' },
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          }
        : {
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            facingMode: deviceId ? undefined : { ideal: 'environment' },
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          };
      const nextStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
      if (cameraTimeoutRef.current) clearTimeout(cameraTimeoutRef.current);
      setStream((old) => {
        old?.getTracks().forEach((track) => track.stop());
        return nextStream;
      });
      setCameraState('ready');
      const listed = await navigator.mediaDevices.enumerateDevices();
      setDevices(listed.filter((device) => device.kind === 'videoinput'));
      notify('Camera connected. Frame the sample, then press Capture.', 'success');
    } catch (error) {
      if (cameraTimeoutRef.current) clearTimeout(cameraTimeoutRef.current);
      const errorName = error instanceof DOMException ? error.name : '';

      if (errorName === 'NotAllowedError') {
        setCameraState('denied');
        setCameraIssue('Camera access is blocked. Tap the lock icon in the browser address bar to allow camera access, then press Connect camera.');
      } else if (errorName === 'NotFoundError') {
        setCameraState('missing');
        setCameraIssue('No camera found on this device. Make sure your webcam or phone camera is available and not disabled.');
      } else if (errorName === 'NotReadableError') {
        setCameraState('denied');
        setCameraIssue('Camera is already being used by another app (e.g., Zoom, Teams, or another browser tab). Close that app first, then try again.');
      } else if (errorName === 'OverconstrainedError' && !retryLowRes) {
        notify('Camera does not support HD. Retrying with lower resolution…', 'warning');
        void connectCamera(deviceId, true);
        return;
      } else {
        setCameraState('denied');
        setCameraIssue(
          `Camera could not be opened (${errorName || 'unknown error'}). Check that the webcam is connected, not in use by another app, and your browser has camera permissions enabled.`,
        );
      }
    }
  }, [notify, selectedDevice]);

  const counts = useMemo(() => grades.reduce((all, grade) => {
    all[grade] = records.filter((record) => record.grade === grade).length;
    return all;
  }, {} as Record<Grade, number>), [records]);
  const typeCounts = useMemo(() => ({
    'Sashibo Core': records.filter((record) => record.sampleType === 'Sashibo Core').length,
    'Tail-Cut': records.filter((record) => record.sampleType === 'Tail-Cut').length,
  }), [records]);
  const rotationComplete = rotationSlices.every(Boolean);
  const resetRotationCycle = useCallback(() => {
    setRotationSlices(Array(6).fill(false));
    setCurrentRotation(0);
  }, []);
  const startNewRotationSample = useCallback(() => {
    resetRotationCycle();
    setIsNewSamplePromptOpen(false);
    notify('New sample ready · Side 1', 'success');
  }, [notify, resetRotationCycle]);
  const latestRecord = records[0];
  const readyToCapture = Boolean(settings.site && settings.operator.trim() && settings.grader.trim() && settings.sampleType && cameraState === 'ready' && videoReady);
  const currentSequence = records.length ? Math.max(...records.map((record) => record.sequence)) + 1 : 1;

  // Compute missing fields for error feedback
  const missingFields = useMemo(() => {
    const missing: string[] = [];
    if (!settings.site) missing.push('Collection site');
    if (!settings.operator.trim()) missing.push('Operator name');
    if (!settings.grader.trim()) missing.push('Expert grader');
    if (!settings.sampleType) missing.push('Sample type');
    if (cameraState !== 'ready' || !videoReady) missing.push('Camera connection');
    return missing;
  }, [settings, cameraState, videoReady]);

  useEffect(() => {
    let active = true;
    const boot = async () => {
      try {
        const stored = await listRecords();
        const next = stored.length ? stored : await migrateLegacyRecords();
        if (!active) return;
        setRecords([...next].sort((a, b) => b.sequence - a.sequence));
        const images = await getAllImages();
        if (!active) return;
        for (const [id, blob] of images) {
          if (blob.size) rememberPreview(id, URL.createObjectURL(blob));
        }
        try { localStorage.removeItem(PREVIEW_STORAGE_KEY); } catch { /* ignore */ }
      } catch {
        if (active) notify('Could not restore previous captures from this device.', 'warning');
      }
    };
    void boot();
    return () => { active = false; };
  }, [notify, rememberPreview]);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    const onInstall = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPrompt); };
    window.addEventListener('beforeinstallprompt', onInstall);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js?v=3').then((registration) => registration.update()).catch(() => undefined);
    return () => window.removeEventListener('beforeinstallprompt', onInstall);
  }, []);

  useEffect(() => {
    let mounted = true;
    const prepareCamera = async () => {
      if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
        setCameraState('missing');
        setCameraIssue('Camera access requires HTTPS or localhost. Open the published PWA, then press Connect camera.');
        return;
      }
      try {
        const listed = await navigator.mediaDevices.enumerateDevices();
        if (mounted) setDevices(listed.filter((device) => device.kind === 'videoinput'));
      } catch {
        if (mounted) setDevices([]);
      }
    };
    prepareCamera();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
      videoRef.current.play().then(() => setVideoReady(true)).catch(() => undefined);
    }
  }, [stream]);

  useEffect(() => () => {
    stream?.getTracks().forEach((track) => track.stop());
    wakeLockRef.current?.release().catch(() => undefined);
    Object.values(previewUrls.current).forEach((url) => URL.revokeObjectURL(url));
    if (cameraTimeoutRef.current) clearTimeout(cameraTimeoutRef.current);
  }, [stream]);

  const discardCapture = useCallback(() => {
    if (capturedPreview) URL.revokeObjectURL(capturedPreview);
    setCapturedBlob(undefined);
    setCapturedPreview(undefined);
    setIsGradeOpen(false);
    setIsCapturing(false);
    setGradeError('');
  }, [capturedPreview]);

  const captureFrame = useCallback(() => {
    if (!readyToCapture || !videoRef.current || !canvasRef.current || isGradeOpen || isCapturing) {
      if (!readyToCapture && missingFields.length) {
        notify(`Cannot capture yet. Missing: ${missingFields.join(', ')}.`, 'warning');
      }
      return;
    }
    if (chamberGuide === 'rotation' && rotationSlices.every(Boolean)) {
      setIsNewSamplePromptOpen(true);
      return;
    }
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      notify('Camera is still warming up — the video stream has not started yet. Wait a moment and try again.', 'warning');
      return;
    }
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) {
      notify('Could not create a canvas context. Try reloading the page.', 'error');
      return;
    }
    setIsCapturing(true);
    context.filter = visionFilter;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    context.filter = 'none';
    canvas.toBlob((blob) => {
      if (!blob) {
        setIsCapturing(false);
        notify('Capture failed — the image could not be created. Try again.', 'error');
        return;
      }
      setCapturedBlob(blob);
      setCapturedPreview(URL.createObjectURL(blob));
      setIsGradeOpen(true);
      setGradeError('');
    }, 'image/jpeg', 0.92);
  }, [capturedPreview, chamberGuide, isCapturing, isGradeOpen, missingFields, notify, readyToCapture, rotationSlices, visionFilter]);

  const writeToFolder = useCallback(async (record: RecordItem, image: Blob) => {
    const handle = folderRef.current;
    if (!handle) return;
    const allowed = await ensureFolderPermission(handle);
    if (!allowed) {
      notify('Folder permission expired. Choose the storage folder again.', 'warning');
      setFolderChosen(false);
      folderRef.current = null;
      return;
    }
    await writeRelativeFile(handle, recordPath(record), image);
  }, [notify]);

  const [isSavingGrade, setIsSavingGrade] = useState(false);

  const finalizeGrade = useCallback(async (grade: Grade) => {
    if (isSavingGrade) return;
    if (!settings.sampleType) {
      setGradeError('No sample type selected. Go back and pick Sashibo Core or Tail-Cut.');
      return;
    }
    const effectiveSampleType = settings.sampleType as SampleType;
    if (!capturedBlob) {
      setGradeError('Capture failed — the image was not saved in memory. Press Discard and try capturing again.');
      return;
    }
    setIsSavingGrade(true);
    const date = today();
    const sequence = currentSequence;
    const record: RecordItem = {
      id: `${Date.now()}-${sequence}`,
      filename: buildFilename(settings.site, effectiveSampleType, grade, sequence, date),
      date,
      site: settings.site,
      sampleType: effectiveSampleType,
      grade,
      sequence,
      createdAt: new Date().toISOString(),
      captureMode: chamberGuide === 'rotation' ? 'rotation' : 'standard',
      rotationSide: chamberGuide === 'rotation' ? currentRotation + 1 : undefined,
    };
    try {
      await putRecord(record, capturedBlob);
    } catch (err) {
      setIsSavingGrade(false);
      const isQuotaError = err instanceof DOMException && (err.name === 'QuotaExceededError' || err.message.includes('quota'));
      if (isQuotaError) {
        setGradeError('Storage is full. Download the ZIP to free up space, then try again.');
      } else {
        setGradeError('Could not save this capture to browser storage. Check storage space and try again.');
      }
      return;
    }
    try {
      await writeToFolder(record, capturedBlob);
    } catch {
      notify('Image saved to browser but could not write to the chosen folder. Check folder permissions.', 'warning');
    }
    rememberPreview(record.id, capturedPreview || URL.createObjectURL(capturedBlob));
    setRecords((current) => [record, ...current]);
    if (chamberGuide === 'rotation' && !rotationSlices[currentRotation]) {
      setRotationSlices((current) => {
        const next = [...current];
        next[currentRotation] = true;
        return next;
      });
      setCurrentRotation((current) => Math.min(current + 1, 5));
    }
    setCapturedBlob(undefined);
    setCapturedPreview(undefined);
    setIsGradeOpen(false);
    setIsCapturing(false);
    setIsSavingGrade(false);
    setGradeError('');
    notify(`${jpegFilename(record)} saved${record.captureMode === 'rotation' ? ` → rotation-pie/Side-${String(record.rotationSide).padStart(2, '0')}` : ''}.`, 'success');
  }, [capturedBlob, capturedPreview, chamberGuide, currentRotation, currentSequence, isSavingGrade, rememberPreview, rotationSlices, settings.sampleType, settings.site, writeToFolder, notify]);

  const undoLast = useCallback(async () => {
    if (!records.length) return;
    const [last, ...rest] = records;
    try {
      await removeRecord(last.id);
      if (folderRef.current) await deleteRelativeFile(folderRef.current, recordPath(last));
      forgetPreview(last.id);
      setRecords(rest);
      notify(`${last.filename} removed. Tally restored.`, 'warning');
    } catch {
      notify('Could not undo the last capture.', 'warning');
    }
  }, [forgetPreview, notify, records]);

  useEffect(() => {
    const handleKeys = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key === '?') {
        event.preventDefault();
        setIsShortcutOpen((current) => !current);
        return;
      }
      if (event.key === 'Escape') {
        if (isShortcutOpen) setIsShortcutOpen(false);
        else if (isNewSamplePromptOpen) setIsNewSamplePromptOpen(false);
        else if (isGradeOpen) discardCapture();
        else if (isReviewOpen) setIsReviewOpen(false);
        else if (isSettingsOpen) setIsSettingsOpen(false);
        else if (isEndOpen) setIsEndOpen(false);
        return;
      }
      if (isNewSamplePromptOpen) {
        if (event.code === 'Space') {
          event.preventDefault();
          startNewRotationSample();
        }
        return;
      }
      if (isGradeOpen) {
        const index = Number(event.key) - 1;
        if (index >= 0 && index < grades.length) {
          event.preventDefault();
          void finalizeGrade(grades[index]);
        }
        return;
      }
      if (event.key.toLowerCase() === 'r' && records.length) {
        event.preventDefault();
        setIsReviewOpen(true);
        return;
      }
      if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        setIsSettingsOpen(true);
        return;
      }
      if (event.key.toLowerCase() === 'e' && records.length) {
        event.preventDefault();
        setIsEndOpen(true);
        return;
      }
      if (event.key.toLowerCase() === 'u' && records.length) {
        event.preventDefault();
        void undoLast();
        return;
      }
      if (event.code === 'Space' && readyToCapture && !isEndOpen && !isReviewOpen && !isSettingsOpen && !isVisionAdjustOpen) {
        event.preventDefault();
        if (chamberGuide === 'rotation' && rotationComplete) {
          setIsNewSamplePromptOpen(true);
          return;
        }
        captureFrame();
      }
    };
    window.addEventListener('keydown', handleKeys);
    return () => window.removeEventListener('keydown', handleKeys);
  }, [captureFrame, chamberGuide, discardCapture, finalizeGrade, isEndOpen, isGradeOpen, isNewSamplePromptOpen, isReviewOpen, isSettingsOpen, isShortcutOpen, isVisionAdjustOpen, readyToCapture, records.length, rotationComplete, startNewRotationSample, undoLast]);

  const deleteRecord = async (id: string) => {
    const item = records.find((record) => record.id === id);
    if (!item) return;
    try {
      await removeRecord(id);
      if (folderRef.current) await deleteRelativeFile(folderRef.current, recordPath(item));
      forgetPreview(id);
      setRecords((current) => current.filter((record) => record.id !== id));
      notify(`${item.filename} removed.`, 'warning');
    } catch {
      notify('Could not delete that capture.', 'warning');
    }
  };

  const overrideGrade = async (id: string, nextGrade: Grade) => {
    const record = records.find((item) => item.id === id);
    if (!record || record.grade === nextGrade || isOverriding) return;
    setIsOverriding(true);
    try {
      const updated: RecordItem = {
        ...record,
        grade: nextGrade,
        filename: buildFilename(record.site, record.sampleType, nextGrade, record.sequence, record.date),
        originalGrade: record.originalGrade ?? record.grade,
        overriddenAt: new Date().toISOString(),
      };
      await updateRecord(updated);
      const image = await getImage(id);
      if (folderRef.current) {
        await deleteRelativeFile(folderRef.current, recordPath(record));
        if (image?.size) await writeRelativeFile(folderRef.current, recordPath(updated), image);
      }
      setRecords((current) => current.map((item) => (item.id === id ? updated : item)));
      notify(`${record.filename} regraded to ${gradeLabels[nextGrade]}.`, 'success');
    } catch {
      notify('Could not change the grade of that capture.', 'error');
    } finally {
      setIsOverriding(false);
    }
  };

  const overrideSampleType = async (id: string, nextSampleType: SampleType) => {
    const record = records.find((item) => item.id === id);
    if (!record || record.sampleType === nextSampleType || isTypeOverriding) return;
    setIsTypeOverriding(true);
    try {
      const updated: RecordItem = {
        ...record,
        sampleType: nextSampleType,
        filename: buildFilename(record.site, nextSampleType, record.grade, record.sequence, record.date),
        originalSampleType: record.originalSampleType ?? record.sampleType,
        overriddenAt: new Date().toISOString(),
      };
      await updateRecord(updated);
      const image = await getImage(id);
      if (folderRef.current) {
        await deleteRelativeFile(folderRef.current, recordPath(record));
        if (image?.size) await writeRelativeFile(folderRef.current, recordPath(updated), image);
      }
      setRecords((current) => current.map((item) => (item.id === id ? updated : item)));
      notify(`${record.filename} re-typed to ${nextSampleType}.`, 'success');
    } catch {
      notify('Could not change the sample type of that capture.', 'error');
    } finally {
      setIsTypeOverriding(false);
    }
  };

  const updateAnnotation = async (id: string, annotations: string[]) => {
    const record = records.find((item) => item.id === id);
    if (!record) return;
    try {
      const updated: RecordItem = {
        ...record,
        annotations: annotations.length > 0 ? annotations : undefined,
      };
      await updateRecord(updated);
      setRecords((current) => current.map((item) => (item.id === id ? updated : item)));
      notify('Annotation updated.', 'success');
    } catch {
      notify('Could not update the annotation.', 'error');
    }
  };

  const exportManifest = (format: 'csv' | 'json') => {
    const content = format === 'json' ? manifestJson(records, settings) : manifestCsv(records, settings);
    triggerDownload(new Blob([content], { type: format === 'json' ? 'application/json' : 'text/csv' }), `tuncam-${today()}-manifest.${format}`);
    notify(`${format.toUpperCase()} manifest downloaded.`, 'success');
  };

  const exportDataset = async () => {
    if (!records.length) {
      notify('Capture at least one sample before downloading the photos.', 'warning');
      return;
    }
    setIsExporting(true);
    notify('Packing photos as date-site-code-grade-sequence.jpg…', 'info');
    try {
      const images = await getAllImages();
      const missing: string[] = [];
      const sampleName = exampleFilename(settings.site);
      const entries: ZipEntry[] = [
        { name: 'HOW-TO-OPEN.txt', data: exportGuideText(settings.site, sampleName) },
      ];
      for (const record of [...records].sort((a, b) => a.sequence - b.sequence)) {
        const image = images.get(record.id);
        const filename = jpegFilename(record);
        if (!image || !image.size) {
          missing.push(filename);
          continue;
        }
        entries.push({ name: photoZipPath(record), data: image });
      }
      entries.push({ name: 'session-manifest.csv', data: manifestCsv(records, settings) });
      entries.push({ name: 'session-manifest.json', data: manifestJson(records, settings) });
      const zip = await buildZip(entries);
      triggerDownload(zip, datasetZipName(settings.site));
      if (folderRef.current) {
        const allowed = await ensureFolderPermission(folderRef.current);
        if (allowed) {
          await writeRelativeFile(folderRef.current, 'HOW-TO-OPEN.txt', exportGuideText(settings.site, sampleName));
          await writeRelativeFile(folderRef.current, 'session-manifest.csv', manifestCsv(records, settings));
          await writeRelativeFile(folderRef.current, 'session-manifest.json', manifestJson(records, settings));
        }
      }
      notify(missing.length ? `Photos downloaded. ${missing.length} image(s) were missing from storage.` : 'ZIP downloaded. Extract it, then open tuncam > date-place > sample type > grade.', 'success');
    } catch {
      notify('Photo download failed. Try exporting CSV/JSON, then retry the ZIP.', 'warning');
    } finally {
      setIsExporting(false);
    }
  };

  const handleImportFile = async (file: File) => {
    if (isImporting) return;
    setIsImporting(true);
    notify(`Reading "${file.name}"…`, 'info');
    try {
      const result = await importSessionZip(file, records);
      if (!result.added.length) {
        notify(result.duplicates ? 'Nothing new to import — every photo already exists on this device.' : 'No importable photos were found in that ZIP.', 'warning');
      } else {
        setRecords((current) => [...result.added, ...current].sort((a, b) => b.sequence - a.sequence));
        for (const record of result.added) {
          const image = result.images.get(record.id);
          if (image?.size) rememberPreview(record.id, URL.createObjectURL(image));
        }
        if (folderRef.current) {
          try {
            const allowed = await ensureFolderPermission(folderRef.current);
            if (allowed) {
              for (const record of result.added) {
                const image = result.images.get(record.id);
                if (image?.size) await writeRelativeFile(folderRef.current, recordPath(record), image);
              }
            }
          } catch {
            notify('Imported to browser storage but could not copy into the chosen folder.', 'warning');
          }
        }
        const parts = [`Imported ${result.added.length} photo${result.added.length === 1 ? '' : 's'}`];
        if (result.duplicates) parts.push(`${result.duplicates} duplicate${result.duplicates === 1 ? '' : 's'} skipped`);
        if (result.missingImages) parts.push(`${result.missingImages} entr${result.missingImages === 1 ? 'y had no' : 'ies had no'} image`);
        notify(`${parts.join(' · ')}.`, 'success');
      }
      setLastImport({ name: file.name, added: result.added.length, duplicates: result.duplicates, missingImages: result.missingImages });
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Import failed — that ZIP could not be read.', 'error');
    } finally {
      setIsImporting(false);
    }
  };

  const chooseFolder = async () => {
    try {
      const handle = await pickSessionFolder();
      if (!handle) {
        notify('Folder access is not available in this browser. Download the ZIP at the end of the session.', 'warning');
        return;
      }
      const allowed = await ensureFolderPermission(handle);
      if (!allowed) {
        notify('Folder permission was not granted. Please allow read/write access and try again.', 'warning');
        return;
      }
      folderRef.current = handle;
      await saveDirectoryHandle(handle);
      setFolderChosen(true);
      setSettings((current) => ({ ...current, storage: handle.name }));
      const images = await getAllImages();
      for (const record of records) {
        const image = images.get(record.id);
        if (image?.size) await writeRelativeFile(handle, recordPath(record), image);
      }
      notify(`Saving into "${handle.name}" — standard captures in sample-type folders, rotation pie in rotation-pie/Side-XX/.`, 'success');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        notify('Folder selection cancelled. Nothing changed.', 'info');
        return;
      }
      if (error instanceof FolderAccessError) {
        notify(error.message, 'error');
        return;
      }
      notify('Could not open that folder. It may be a system folder or restricted. Try choosing a different one.', 'error');
    }
  };

  useEffect(() => {
    let active = true;
    const restoreFolder = async () => {
      const handle = await loadDirectoryHandle();
      if (!handle || !active) return;
      const allowed = await handle.queryPermission({ mode: 'readwrite' });
      if (allowed === 'granted' && active) {
        folderRef.current = handle;
        setFolderChosen(true);
        setSettings((current) => current.storage === handle.name ? current : { ...current, storage: handle.name });
      }
    };
    void restoreFolder();
    return () => { active = false; };
  }, []);

  const toggleAwake = async () => {
    const nav = navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> } };
    if (isAwake && wakeLockRef.current) {
      await wakeLockRef.current.release().catch(() => undefined);
      wakeLockRef.current = null;
      setIsAwake(false);
      notify('Screen sleep prevention paused.', 'info');
      return;
    }
    if (!nav.wakeLock) { setWakeSupport('unsupported'); notify('This browser cannot prevent sleep. Keep the device connected to power.', 'warning'); return; }
    try {
      wakeLockRef.current = await nav.wakeLock.request('screen');
      setWakeSupport('supported');
      setIsAwake(true);
      notify('Screen will stay awake during capture.', 'success');
    } catch { setWakeSupport('unsupported'); notify('Screen sleep prevention was blocked by the browser.', 'warning'); }
  };

  const installApp = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    setInstallPrompt(null);
  };

  // Auto-export when ending session
  const handleEndSession = useCallback(async () => {
    if (!records.length) {
      notify('No captures to export.', 'info');
      return;
    }
    await exportDataset();
  }, [records.length, notify, exportDataset]);

  // Confirm End Session & clear storage for next session
  const handleConfirmEndSession = useCallback(async () => {
    try {
      await clearSession();
      Object.values(previewUrls.current).forEach((url) => URL.revokeObjectURL(url));
      previewUrls.current = {};
      setPreviews({});
      setRecords([]);
      setIsEndOpen(false);
      // Clear preview URLs from localStorage
      try { localStorage.removeItem(PREVIEW_STORAGE_KEY); } catch { /* ignore */ }
      notify('Session ended. Dataset exported and storage cleared for next session.', 'success');
    } catch {
      notify('Could not clear session data completely.', 'error');
    }
  }, [notify]);

  return (
    <div className="noise app-shell console-shell">
      <main className="dashboard-frame dashboard-compact">
        <header className="console-header flex min-h-16 items-center justify-between gap-3 rounded-full py-1 pl-12 pr-4 sm:min-h-[4.5rem] sm:pl-16 sm:pr-5 lg:min-h-[6rem] lg:py-1.5 lg:pl-20">
          <div className="flex min-w-0 shrink-0 items-center">
            <img
              src="/TUNAEYELOGO.svg"
              alt="TunaEye"
              className="console-brand-logo h-16 w-auto max-w-[min(78vw,500px)] object-contain object-left sm:h-[4.75rem] sm:max-w-[580px] lg:h-[5.75rem] lg:max-w-[720px]"
            />
          </div>
          <div className="hidden items-center gap-4 lg:flex">
            <span className="flex items-center gap-1.5 text-[10px] font-semibold text-white/75"><span className="size-1.5 rounded-full bg-[#4ade80]" /> Offline-ready</span>
            <span className="text-[10px] font-semibold text-white/55">PH · ₱ PHP</span>
            <span className="mono text-[10px] font-bold text-white/80">UNIT {siteCode(settings.site)}</span>
            <span className="h-5 w-px bg-white/15" />
            <div className="text-right"><p className="text-[8px] font-semibold uppercase tracking-[.12em] text-white/50">Session</p><p className="mono text-[11px] font-medium text-white/90">{today()}</p></div>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2">
            {installPrompt && <button type="button" data-testid="button-install-app" onClick={installApp} className="focus-ring hidden items-center gap-2 rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-[10px] font-bold text-white sm:flex"><Download size={14} />Install</button>}
            <button type="button" onClick={() => setIsShortcutOpen(true)} className="focus-ring hidden items-center gap-2 rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-[10px] font-bold text-white md:flex"><Keyboard size={14} /> Shortcuts</button>
            <button type="button" data-testid="button-open-settings" onClick={() => setIsSettingsOpen(true)} className="focus-ring flex size-8 items-center justify-center rounded-lg border border-white/20 bg-white/10 text-white transition hover:bg-white/20 sm:size-9" aria-label="Open session tools"><Settings2 size={16} /></button>
          </div>
        </header>

        <ProtocolStepper ready={readyToCapture} hasCaptures={records.length > 0} grading={isGradeOpen} />

        {/* ─── SHORTCUT STRIP (hidden on mobile) ─── */}
        <section className="console-strip mt-2 hidden flex-wrap items-center justify-between gap-2 rounded-xl px-3 py-2 lg:flex">
          <div className="flex flex-wrap items-center gap-2">
            <ShortcutPill keys="Space" label="Capture" />
            <ShortcutPill keys="1 2 3 4" label="Grade" />
            <ShortcutPill keys="R" label="Review" />
            <ShortcutPill keys="U" label="Undo" />
            <ShortcutPill keys="?" label="Help" />
          </div>
          <div className="text-[10px] font-bold text-[#667f92]">
            {latestRecord ? `Last saved: ${jpegFilename(latestRecord)}` : 'No captures yet. Frame the sample and press Space.'}
          </div>
        </section>

        {/* ─── MAIN 3-COL GRID (stacks on mobile) ─── */}
        <section className="dashboard-grid mt-1.5 grid gap-2 sm:mt-2 lg:grid-cols-[220px_minmax(0,1fr)_250px] xl:grid-cols-[240px_minmax(0,1fr)_270px]">
          {/* ── LEFT: Session Setup ── */}
          <aside className="console-card rounded-2xl p-2.5 sm:p-3">
            <div className="mb-2 flex items-start justify-between sm:mb-2.5">
              <div>
                <h2 className="text-[13px] font-extrabold tracking-[-.03em] text-[#0a1f44] sm:text-[14px]">Session context</h2>
              </div>
              <div className="rounded-lg bg-[#eef2f8] p-1.5 text-[#0a1f44]"><ClipboardList size={15} /></div>
            </div>
            <div className="space-y-2">
              <label><span className="field-label">Collection site <span className="text-[#d87871]">*</span></span><select data-testid="select-collection-site" value={settings.site} onChange={(event) => { if (event.target.value === '__new') { setSettings({ ...settings, site: '' }); setCustomSite(''); } else setSettings({ ...settings, site: event.target.value }); }} className="field-control field-control-compact"><option>General Santos City Fish Port Complex</option><option>Pag-Asa Bankerohan Fish Vendors Association, Inc. (Fish Bagsakan)</option>{customSite && <option value={customSite}>{customSite}</option>}<option value="__new">Add a new site…</option></select></label>
              {!settings.site && <div className="relative"><Plus className="field-icon" size={14} /><input data-testid="input-new-site" value={customSite} onChange={(event) => { setCustomSite(event.target.value); setSettings({ ...settings, site: event.target.value }); }} className="field-control field-control-compact with-icon" placeholder="e.g. Makar Wharf, Gensan" /></div>}
              <label><span className="field-label">Operator name <span className="text-[#d87871]">*</span></span><div className="relative"><UserRound className="field-icon" size={14} /><input data-testid="input-operator-name" value={settings.operator} onChange={(event) => setSettings({ ...settings, operator: event.target.value })} className="field-control field-control-compact with-icon" placeholder="Who is capturing?" autoComplete="name" /></div></label>
              <label><span className="field-label">Expert grader <span className="text-[#d87871]">*</span></span><div className="relative"><BadgeCheck className="field-icon" size={14} /><input data-testid="input-grader-name" value={settings.grader} onChange={(event) => setSettings({ ...settings, grader: event.target.value })} className="field-control field-control-compact with-icon" placeholder="Who is grading?" autoComplete="name" /></div></label>
              <label><span className="field-label">Storage location</span><button type="button" data-testid="button-choose-folder" onClick={() => void chooseFolder()} className="focus-ring flex h-9 w-full items-center gap-2 rounded-xl border border-[#d5e5ee] bg-[#f7fbfd] px-2.5 text-left text-[10px] text-[#557187] hover:border-[#7bc7e5]"><FolderOpen size={14} className="shrink-0 text-[#319ccc]" /><span className="min-w-0 flex-1 truncate">{folderChosen ? settings.storage : 'Choose any folder…'}</span><ChevronDown size={13} className="text-[#9ab1c0]" /></button></label>
              <div>
                <span className="console-eyebrow">Sample type <span className="text-[#e85d52]">*</span></span>
                <div className="mt-1.5 grid grid-cols-2 gap-1">
                  <ProtocolSampleCard label="Sashibo-Core" value="Sashibo Core" selected={settings.sampleType === 'Sashibo Core'} onSelect={() => setSettings({ ...settings, sampleType: 'Sashibo Core' })} />
                  <ProtocolSampleCard label="Tail-Cut" value="Tail-Cut" selected={settings.sampleType === 'Tail-Cut'} onSelect={() => setSettings({ ...settings, sampleType: 'Tail-Cut' })} />
                </div>
              </div>
            </div>
            <div className={`mt-2 rounded-[12px] border px-2.5 py-2 ${readyToCapture ? 'border-[#bde7da] bg-[#f0fbf7]' : 'border-[#e2edf2] bg-[#f8fbfc]'}`}>
              <div className="flex items-center gap-2">
                <span className={`size-2 rounded-full ${readyToCapture ? 'status-breathe bg-[#29b685]' : 'bg-[#c6d5de]'}`} />
                <span className="text-[9px] font-bold text-[#49677b] sm:text-[10px]">{readyToCapture ? 'Ready for manual capture' : 'Complete required fields'}</span>
              </div>
              <p className="mt-0.5 text-[8px] leading-3.5 text-[#8198a8] sm:text-[9px]">{readyToCapture ? 'Press Capture or Spacebar when the sample is framed.' : `Missing: ${missingFields.join(', ')}.`}</p>
            </div>
          </aside>

          <section ref={chamberRef} className="console-card stage-card flex min-h-0 min-w-0 flex-col rounded-2xl p-2 sm:p-2.5">
            <div className="mb-1.5 flex items-center gap-2 sm:mb-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="text-[13px] font-extrabold tracking-[-.03em] text-[#0a1f44] sm:text-[14px]">Imaging chamber</h2>
                  <span className={`flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[7px] font-extrabold uppercase tracking-[.08em] sm:text-[8px] ${cameraState === 'ready' ? 'bg-[#e5f8f2] text-[#238866]' : cameraState === 'idle' ? 'bg-[#edf1ff] text-[#3658c4]' : cameraState === 'loading' ? 'bg-[#fff8e8] text-[#bc8d49]' : 'bg-[#fff3e8] text-[#bc7449]'}`}>
                    {cameraState === 'ready' && <span className="live-dot size-1.5 rounded-full bg-[#29b685]" />}
                    {cameraState === 'ready' ? 'Live' : cameraState === 'loading' ? 'Connecting…' : cameraState === 'idle' ? 'Offline' : cameraState === 'denied' ? 'Permission' : cameraState === 'timeout' ? 'Timeout' : 'No camera'}
                  </span>
                </div>
              </div>
              <div className="flex shrink-0 justify-center">
                <div className="flex rounded-full border border-[#d8e0ea] bg-white p-0.5">
                  <button type="button" data-testid="button-guide-framing" onClick={() => setChamberGuide('framing')} className={`focus-ring rounded-md px-2 py-1 text-[8px] font-extrabold transition sm:text-[9px] ${chamberGuide === 'framing' ? 'navy-sheen text-white shadow-sm' : 'text-[#5c6b7f] hover:bg-[#f4f7fa]'}`}>Square capture</button>
                  <button type="button" data-testid="button-guide-rotation" onClick={() => setChamberGuide('rotation')} className={`focus-ring rounded-md px-2 py-1 text-[8px] font-extrabold transition sm:text-[9px] ${chamberGuide === 'rotation' ? 'navy-sheen text-white shadow-sm' : 'text-[#5c6b7f] hover:bg-[#f4f7fa]'}`}>Rotation pie</button>
                </div>
              </div>
              <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-1">
                <button
                  type="button"
                  data-testid="button-vision-adjust"
                  onClick={() => setIsVisionAdjustOpen(true)}
                  className={`focus-ring flex h-7 items-center gap-1 rounded-lg border px-2 text-[8px] font-extrabold sm:text-[9px] ${isDefaultAdjustments(imageAdjustments) ? 'border-[#d8e0ea] bg-white text-[#5c6b7f] hover:border-[#4169e1]/40' : 'border-[#4169e1]/50 bg-[#eff6ff] text-[#1e40af]'}`}
                >
                  <Eye size={12} /> Vision
                </button>
                <button type="button" data-testid="button-refresh-camera" onClick={() => { setSelectedDevice(''); void connectCamera(''); }} className="focus-ring flex size-7 items-center justify-center rounded-lg border border-[#dce9ef] bg-white/80 text-[#6e899b] hover:text-[#3658c4]" aria-label="Connect or refresh camera"><RefreshCw size={13} /></button>
                <select
                  data-testid="select-camera-device"
                  value={selectedDevice}
                  title={devices.find((device) => device.deviceId === selectedDevice)?.label || 'Default camera'}
                  onChange={(event) => { const deviceId = event.target.value; setSelectedDevice(deviceId); void connectCamera(deviceId); }}
                  className="focus-ring h-7 min-w-[7rem] max-w-[11rem] shrink-0 rounded-lg border border-[#dce9ef] bg-white/80 px-2 text-[9px] text-[#587185] sm:max-w-[13rem]"
                  aria-label="Camera device"
                >
                  <option value="">Default camera</option>
                  {devices.map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}
                </select>
              </div>
            </div>
            <div className={`relative min-h-0 flex-1 overflow-hidden rounded-xl bg-[#dce9ee] sm:rounded-2xl ${isCapturing ? 'capture-pulse' : ''}`} style={{ aspectRatio: '16/10' }}>
              {cameraState === 'ready' ? <video ref={videoRef} muted playsInline onLoadedMetadata={() => setVideoReady(true)} className="absolute inset-0 size-full object-cover" style={{ filter: visionFilter }} data-testid="video-camera-preview" /> : <CameraEmpty state={cameraState} issue={cameraIssue} onRetry={() => void connectCamera()} />}
              {cameraState === 'ready' && chamberGuide === 'framing' && (
                <SquareCaptureOverlay crosshair={framingCrosshair} onCrosshairChange={updateFramingCrosshair} />
              )}
              {cameraState === 'ready' && chamberGuide === 'rotation' && (
                <RotationPieOverlay
                  slices={rotationSlices}
                  current={currentRotation}
                  complete={rotationComplete}
                  settings={rotationPieSettings}
                  onSettingsChange={updateRotationPieSettings}
                  onSelectSlice={setCurrentRotation}
                  onReset={resetRotationCycle}
                />
              )}
            </div>
            <canvas ref={canvasRef} className="hidden" />
            {/* Desktop capture controls */}
            <div className="mt-1.5 hidden grid-cols-[1fr_auto_1fr] items-center gap-2 md:grid">
              <div className="flex items-center gap-1.5">
                <div className="rounded-lg bg-[#eaf5fa] p-1.5 text-[#3b9fca]"><ScanLine size={13} /></div>
                <div>
                  <p className="text-[9px] font-bold text-[#4b687d]">{chamberGuide === 'rotation' ? `Rotation ${currentRotation + 1}/6 · ${ROTATION_LABELS[currentRotation]}` : 'Square capture'}</p>
                  <p className="text-[8px] text-[#8ca1af]">Press Capture when ready</p>
                </div>
              </div>
              <button type="button" data-testid="button-capture" disabled={!readyToCapture} onClick={captureFrame} className={`capture-button capture-button-primary focus-ring relative flex h-14 min-w-52 items-center justify-center px-6 text-white transition hover:-translate-y-0.5 disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-45 lg:h-16 lg:min-w-60 lg:px-8 ${readyToCapture ? 'navy-sheen' : 'bg-[#94a3b8]'}`}>
                <span className="capture-button-label">CAPTURE SAMPLE</span>
              </button>
              <div className="flex justify-end"><button type="button" data-testid="button-undo-last" disabled={!records.length} onClick={() => void undoLast()} className="action-btn focus-ring px-2.5 py-2 text-[9px]"><Undo2 size={13} /> Undo</button></div>
            </div>
          </section>

          <aside className="flex min-h-0 flex-col gap-1.5 sm:gap-2">
            <GradeSummaryCard counts={counts} total={records.length} latestRecord={latestRecord} />
            <div className="console-card rounded-2xl p-2.5 sm:p-3">
              <div className="flex items-center justify-between"><div><p className="text-[10px] font-bold text-[#0a1f44] sm:text-[11px]">Class balance</p></div><SlidersHorizontal size={14} className="text-[#64748b]" /></div>
              <div className="mt-1.5 space-y-1.5 sm:space-y-2">{(['Sashibo Core', 'Tail-Cut'] as SampleType[]).map((type) => <div key={type}><div className="mb-0.5 flex items-center justify-between text-[8px] sm:text-[9px]"><span className="font-bold text-[#5c7587]">{type}</span><span className="tabular-nums font-semibold text-[#849aa8]">{typeCounts[type]} / {PROGRESS_TARGET}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-[#e8edf5]"><div className="h-full rounded-full navy-sheen transition-all duration-500" style={{ width: `${Math.min(100, (typeCounts[type] / PROGRESS_TARGET) * 100)}%` }} /></div></div>)}</div>
            </div>

            {/* Wrap-up: download, review, import, end session */}
            <ActionsPanel
              exampleName={exampleFilename(settings.site)}
              count={records.length}
              exporting={isExporting}
              importing={isImporting}
              dragOver={importDragOver}
              lastImport={lastImport}
              onDownload={() => void exportDataset()}
              onReview={() => setIsReviewOpen(true)}
              onEnd={() => setIsEndOpen(true)}
              onImportClick={() => importInputRef.current?.click()}
              onDragStateChange={setImportDragOver}
              onDropFile={(file) => void handleImportFile(file)}
            />
            <input ref={importInputRef} type="file" accept=".zip,application/zip,application/x-zip-compressed" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void handleImportFile(file); }} data-testid="input-import-zip" />
          </aside>
        </section>

        {/* ─── FOOTER ─── */}
        <footer className="mt-1 flex flex-wrap items-center justify-between gap-1.5 px-1 pb-1 text-[8px] text-[#7d95a5] sm:text-[9px]"><div className="flex items-center gap-2"><span className="flex items-center gap-1"><Zap size={11} className="text-[#28a5d0]" /> Manual capture</span><span className="hidden h-3 w-px bg-[#cbdde6] sm:inline" /><span className="hidden items-center gap-1 sm:flex"><ShieldCheck size={11} className="text-[#49a88a]" /> Offline</span></div><div className="flex items-center gap-2"><button type="button" data-testid="button-toggle-awake" onClick={() => void toggleAwake()} className={`focus-ring flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-[8px] font-bold sm:text-[9px] ${isAwake ? 'bg-[#e5f8f2] text-[#25886e]' : 'hover:bg-white/70'}`}>{isAwake ? <Pause size={10} /> : <MonitorDown size={10} />}{isAwake ? 'Awake' : 'No sleep'}</button><span className="mono">v1.0</span></div></footer>
      </main>

      {/* ─── MOBILE STICKY CAPTURE BAR ─── */}
      <div className="mobile-capture-bar fixed inset-x-0 bottom-0 z-20 flex items-center justify-between gap-3 border-t border-[#d5e5ee] bg-white/95 px-3 py-2.5 shadow-[0_-8px_24px_rgba(20,60,90,.12)] backdrop-blur-md safe-bottom md:hidden">
        <div className="flex items-center gap-2">
          <span className={`size-2 rounded-full ${readyToCapture ? 'status-breathe bg-[#29b685]' : 'bg-[#c6d5de]'}`} />
          <span className="mono text-[12px] font-bold text-[#24435a]">{records.length}</span>
          <span className="text-[9px] text-[#8198a8]">captured</span>
        </div>
        <button
          type="button"
          data-testid="button-capture-mobile"
          disabled={!readyToCapture}
          onClick={captureFrame}
          className={`capture-button capture-button-primary focus-ring flex h-14 min-w-48 items-center justify-center px-6 text-white transition disabled:cursor-not-allowed disabled:opacity-45 ${readyToCapture ? 'navy-sheen' : 'bg-[#94a3b8]'}`}
        >
          <span className="capture-button-label">CAPTURE SAMPLE</span>
        </button>
        <button
          type="button"
          data-testid="button-undo-mobile"
          disabled={!records.length}
          onClick={() => void undoLast()}
          className="focus-ring flex size-10 items-center justify-center rounded-xl border border-[#d8e7ee] bg-white/70 text-[#617b8d] disabled:opacity-40"
        >
          <Undo2 size={16} />
        </button>
      </div>

      {/* ─── MODALS ─── */}
      {isNewSamplePromptOpen && (
        <NewSampleModal
          onConfirm={startNewRotationSample}
          onClose={() => setIsNewSamplePromptOpen(false)}
        />
      )}
      {isGradeOpen && <GradeModal image={capturedPreview} error={gradeError} onSelect={(grade) => void finalizeGrade(grade)} onCancel={discardCapture} />}
      {isReviewOpen && <ReviewModal records={records} previews={previews} exporting={isExporting} overriding={isOverriding} onClose={() => setIsReviewOpen(false)} onDelete={(id) => void deleteRecord(id)} onOverrideGrade={(id, grade) => void overrideGrade(id, grade)} onAnnotationUpdate={(id, annotations) => void updateAnnotation(id, annotations)} onTypeOverride={(id, sampleType) => void overrideSampleType(id, sampleType)} onExport={exportManifest} onDownload={() => void exportDataset()} />}
      {isEndOpen && <EndModal records={records} settings={settings} exporting={isExporting} onClose={() => setIsEndOpen(false)} onConfirmEnd={handleConfirmEndSession} onExport={exportManifest} onDownload={handleEndSession} />}
      {isSettingsOpen && <ToolsModal settings={settings} onClose={() => setIsSettingsOpen(false)} onInstall={installPrompt ? installApp : undefined} />}
      {isShortcutOpen && <ShortcutModal onClose={() => setIsShortcutOpen(false)} />}
      {isVisionAdjustOpen && (
        <VisionAdjustPanel
          adjustments={imageAdjustments}
          filter={visionFilter}
          onChange={updateImageAdjustments}
          onApply={applyImageAdjustments}
          onClose={() => setIsVisionAdjustOpen(false)}
        />
      )}

      {/* ─── TOASTS ─── */}
      <div className="fixed bottom-16 left-1/2 z-50 flex w-[min(92vw,390px)] -translate-x-1/2 flex-col gap-2 md:bottom-4">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast-in flex items-center gap-2 rounded-xl border px-3 py-2 text-[10px] font-bold shadow-[0_12px_30px_rgba(38,80,112,.16)] sm:py-2.5 sm:text-[11px] ${toast.tone === 'success' ? 'border-[#b9e8d7] bg-[#f0fbf7] text-[#267f69]' : toast.tone === 'warning' ? 'border-[#f0d4c2] bg-[#fff7f1] text-[#a66b54]' : toast.tone === 'error' ? 'border-[#f0b8b4] bg-[#fff1f0] text-[#a64843]' : 'border-[#c8e4ee] bg-white text-[#4c6c80]'}`}>
            {toast.tone === 'error' ? <AlertTriangle size={14} /> : <Info size={14} />} {toast.message}
          </div>
        ))}
      </div>

      <p className="app-tagline pointer-events-none fixed bottom-14 left-1/2 z-10 w-full max-w-lg -translate-x-1/2 px-4 text-center text-[8px] font-semibold uppercase tracking-[.14em] text-[#0a1f44]/40 sm:bottom-3 sm:text-[9px]">
        Data collection capture console for TunaEye™
      </p>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   Sub-components
   ═══════════════════════════════════════════════════════════════════════════ */

function useRecordImageUrl(recordId: string) {
  const [url, setUrl] = useState<string | undefined>();
  const [error, setError] = useState(false);
  const ownedRef = useRef<string | undefined>();

  useEffect(() => {
    let active = true;
    setError(false);
    setUrl(undefined);

    if (ownedRef.current) {
      URL.revokeObjectURL(ownedRef.current);
      ownedRef.current = undefined;
    }

    getImage(recordId)
      .then((blob) => {
        if (!active) return;
        if (blob?.size) {
          const objectUrl = URL.createObjectURL(blob);
          ownedRef.current = objectUrl;
          setUrl(objectUrl);
        } else {
          setError(true);
        }
      })
      .catch(() => {
        if (active) setError(true);
      });

    return () => {
      active = false;
      if (ownedRef.current) {
        URL.revokeObjectURL(ownedRef.current);
        ownedRef.current = undefined;
      }
    };
  }, [recordId]);

  return { url, error };
}

function RecordThumbnail({ record }: { record: RecordItem; previewUrl?: string }) {
  const { url, error } = useRecordImageUrl(record.id);

  if (error || !url) {
    return (
      <div className="flex size-full flex-col items-center justify-center bg-[#f1f5f9] p-2 text-center text-[#94a3b8]">
        <ImageIcon size={22} className="mb-1 opacity-60" />
        <span className="text-[8px] font-bold">No preview</span>
      </div>
    );
  }

  return (
    <img
      src={url}
      alt={jpegFilename(record)}
      className="size-full object-cover transition duration-300 group-hover:scale-[1.03]"
    />
  );
}

function ActionsPanel({ exampleName, count, exporting, importing, dragOver, lastImport, onDownload, onReview, onEnd, onImportClick, onDragStateChange, onDropFile }: {
  exampleName: string;
  count: number;
  exporting: boolean;
  importing: boolean;
  dragOver: boolean;
  lastImport: { name: string; added: number; duplicates: number; missingImages: number } | null;
  onDownload: () => void;
  onReview: () => void;
  onEnd: () => void;
  onImportClick: () => void;
  onDragStateChange: (active: boolean) => void;
  onDropFile: (file: File) => void;
}) {
  return (
    <div
      data-testid="panel-import"
      onDragOver={(event) => { event.preventDefault(); if (!dragOver) onDragStateChange(true); }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) onDragStateChange(false); }}
      onDrop={(event) => {
        event.preventDefault();
        onDragStateChange(false);
        const file = event.dataTransfer.files?.[0];
        if (file) onDropFile(file);
      }}
      className={`soft-card export-card console-card rounded-2xl p-2.5 sm:p-3 ${dragOver ? 'import-dropzone-active' : 'import-dropzone'}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-[13px] font-extrabold tracking-[-.03em] text-[#203c53] sm:text-[14px]">Export &amp; merge</h2>
        </div>
        <div className={`rounded-lg p-1.5 transition ${dragOver ? 'blue-sheen text-white' : 'bg-[#eaf6fb] text-[#2aa6d7]'}`}><FileImage size={15} /></div>
      </div>
      {count > 0 && <FilenamePreview name={exampleName} />}
      <button
        type="button"
        data-testid="button-download-dataset"
        disabled={!count || exporting}
        onClick={onDownload}
        className="capture-button navy-sheen focus-ring mt-2 flex w-full items-center justify-center gap-2 rounded-xl py-2 text-[9px] font-extrabold text-white transition hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-40 sm:py-2.5 sm:text-[10px]"
      >
        <Download size={14} />{exporting ? 'Packing photos…' : `Download ${count || 0} photo${count === 1 ? '' : 's'} ZIP`}
      </button>

      <div className="mt-2 grid grid-cols-2 gap-1.5 sm:gap-2">
        <button type="button" data-testid="button-open-review" onClick={onReview} className="action-btn focus-ring text-[9px] sm:text-[10px]">
          <ImageIcon size={13} /> Review
          <span className="mono rounded-full bg-[#eaf4f8] px-1.5 py-0.5 text-[8px] font-bold text-[#4182a1]">{count}</span>
        </button>
        <button type="button" data-testid="button-import-data" disabled={importing} onClick={onImportClick} className="action-btn action-btn-accent focus-ring text-[9px] sm:text-[10px]" title={importing ? 'Reading session ZIP…' : 'Merge a TUNCAM ZIP exported on another laptop'}>
          {importing ? <Loader2 size={13} className="animate-spin" /> : <FileUp size={13} />}
          {importing ? 'Merging…' : 'Import'}
        </button>
      </div>
      <button type="button" data-testid="button-end-session" onClick={onEnd} className="action-btn action-btn-danger focus-ring mt-2 w-full text-[9px] sm:text-[10px]">
        <Archive size={13} /> End session
      </button>

      <p className="mt-2 flex items-center justify-center gap-1.5 text-center text-[8px] leading-3.5 text-[#93a9b7] sm:text-[9px]">
        <LaptopMinimal size={11} className="shrink-0" />
        {importing ? 'Merging photos from that session…' : dragOver ? 'Release to merge this session into today\u2019s tally.' : 'Drop a TUNCAM ZIP from another laptop here to merge it — duplicates skip automatically.'}
      </p>

      {lastImport && (
        <div data-testid="summary-import" className="fade-up mt-2 rounded-xl border border-[#e3edf3] bg-[#f8fbfc] px-2.5 py-2">
          <p className="mono truncate text-[8px] font-bold text-[#5b7a8e] sm:text-[9px]" title={lastImport.name}>{lastImport.name}</p>
          <div className="mt-1.5 flex flex-wrap gap-1 sm:gap-1.5">
            <span className="rounded-full bg-[#ebf8f4] px-2 py-0.5 text-[7px] font-extrabold uppercase tracking-[.06em] text-[#25886e] sm:text-[8px]">+{lastImport.added} imported</span>
            {lastImport.duplicates > 0 && <span className="rounded-full bg-[#fff7ec] px-2 py-0.5 text-[7px] font-extrabold uppercase tracking-[.06em] text-[#b98a49] sm:text-[8px]">{lastImport.duplicates} duplicate{lastImport.duplicates === 1 ? '' : 's'} skipped</span>}
            {lastImport.missingImages > 0 && <span className="rounded-full bg-[#fff1f0] px-2 py-0.5 text-[7px] font-extrabold uppercase tracking-[.06em] text-[#bd685f] sm:text-[8px]">{lastImport.missingImages} no image</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function FilenamePreview({ name }: { name: string }) {
  // Parse new short format: YY-MM-DD-SITE-SC-GRD_A-001.jpg
  const base = name.replace(/\.jpg$/i, '');
  const segments = base.split('-');
  // segments: ["26", "08", "24", "BNK", "SC", "GRD_A", "001"]
  const date = segments.slice(0, 3).join('-');
  const site = segments[3] || 'BNK';
  const type = segments[4] || 'SC';
  const grade = segments[5] || 'GRD_A';
  const seq = segments[6] || '001';
  return (
    <div className="filename-chip mt-2 rounded-[14px] border border-[#d4e6f0] bg-white/85 p-2.5 sm:mt-3 sm:rounded-2xl sm:p-3">
      <p className="break-all font-mono text-[11px] font-bold leading-5 text-[#214e69] sm:text-[12px]">{name}</p>
      <div className="mt-1.5 flex flex-wrap gap-1 sm:mt-2">
        {[
          ['date', date],
          ['site', site],
          ['type', type],
          ['grade', grade],
          ['seq', seq],
        ].map(([label, value]) => (
          <span key={label} className="rounded-full bg-[#eef6fb] px-1.5 py-0.5 text-[7px] font-bold uppercase tracking-[.06em] text-[#5b7a8e] sm:px-2 sm:text-[8px]">
            {label} {value}
          </span>
        ))}
      </div>
    </div>
  );
}

function StatusChip({ icon, label, tone }: { icon: ReactNode; label: string; tone: 'cyan' | 'green' | 'violet' }) {
  return <span className={`flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[10px] font-bold ${tone === 'cyan' ? 'bg-[#e8f7fc] text-[#2483ac]' : tone === 'green' ? 'bg-[#eaf8f3] text-[#2a8b6c]' : 'bg-[#f0ecff] text-[#6656c1]'}`}>{icon}{label}</span>;
}
function ShortcutPill({ keys, label }: { keys: string; label: string }) {
  return <span className="flex items-center gap-2 rounded-full border border-[#dce8f1] bg-white/85 px-3 py-1.5 text-[10px] font-bold text-[#527084]"><span className="mono rounded-md bg-[#eef4ff] px-1.5 py-0.5 text-[9px] text-[#4960ce]">{keys}</span>{label}</span>;
}
function ProtocolStepper({ ready, hasCaptures, grading }: { ready: boolean; hasCaptures: boolean; grading: boolean }) {
  const active = grading ? 3 : hasCaptures ? 4 : ready ? 2 : 1;
  const steps = ['Session setup', 'Live capture', 'Grade sample', 'Review & export'];
  return (
    <div className="console-stepper mt-2 flex flex-wrap items-center gap-2 rounded-xl px-3 py-2.5 sm:gap-3 sm:px-4">
      {steps.map((label, index) => {
        const step = index + 1;
        const isActive = step === active;
        const isDone = step < active;
        return (
          <div key={label} className="flex min-w-0 flex-1 items-center gap-2">
            <span className={`flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-extrabold sm:size-7 sm:text-[11px] ${isActive ? 'navy-sheen text-white shadow-md' : isDone ? 'navy-sheen text-white opacity-90' : 'border border-[#d8e0ea] bg-white text-[#94a3b8]'}`}>
              {isDone ? <Check size={12} /> : step}
            </span>
            <span className={`hidden truncate text-[9px] font-bold sm:block sm:text-[10px] ${isActive ? 'text-[#0a1f44]' : 'text-[#94a3b8]'}`}>{label}</span>
            {index < steps.length - 1 && <span className="hidden h-px flex-1 bg-[#e2e8f0] sm:block" />}
          </div>
        );
      })}
    </div>
  );
}

function GradeSummaryCard({ counts, total, latestRecord }: {
  counts: Record<Grade, number>;
  total: number;
  latestRecord?: RecordItem;
}) {
  return (
    <div className="console-card rounded-2xl p-2.5 sm:p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-extrabold text-[#0a1f44] sm:text-[12px]">Grade summary</p>
        </div>
        <div className="text-right">
          <p className="text-[7px] font-bold uppercase tracking-[.1em] text-[#94a3b8]">Total</p>
          <p data-testid="text-total-captured" className="text-[18px] font-extrabold leading-none text-[#0a1f44] sm:text-[20px]">{total}</p>
        </div>
      </div>
      <div className="mt-2.5 grid grid-cols-4 gap-1.5">
        {grades.map((grade) => {
          const count = counts[grade];
          const color = gradeColors[grade];
          return (
            <div
              key={grade}
              className="flex flex-col items-center rounded-xl px-1 py-2"
              style={{ background: `${color}14`, boxShadow: `inset 0 0 0 1px ${color}28` }}
            >
              <div
                className="flex size-7 items-center justify-center rounded-full text-[10px] font-extrabold text-white shadow-sm sm:size-8 sm:text-[11px]"
                style={{ background: color }}
              >
                {grade === 'Invalid' ? '!' : grade}
              </div>
              <p
                data-testid={`text-count-${grade.toLowerCase()}`}
                className="mt-1 text-[15px] font-extrabold tabular-nums leading-none sm:text-[16px]"
                style={{ color: count ? color : '#cbd5e1' }}
              >
                {count}
              </p>
            </div>
          );
        })}
      </div>
      {latestRecord && (
        <div className="mt-2 rounded-lg border border-[#e8edf2] bg-[#f8fafc] px-2 py-1.5">
          <p className="text-[7px] font-bold uppercase tracking-[.08em] text-[#94a3b8]">Last capture</p>
          <p className="mt-0.5 truncate text-[8px] font-semibold text-[#475569] sm:text-[9px]" title={jpegFilename(latestRecord)}>
            {jpegFilename(latestRecord)}
          </p>
        </div>
      )}
    </div>
  );
}

function SashiboCoreIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 52" className={className} fill="none" aria-hidden="true">
      <rect x="11" y="4" width="18" height="44" stroke="currentColor" strokeWidth="2" />
      <path d="M14 12h12M13.5 20h13M14 28h12M13.5 36h13M14 44h12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.75" />
      <path d="M6 26h4M30 26h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M8 26l-2 0M32 26l2 0" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.7" />
    </svg>
  );
}

function TailCutIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 52" className={className} fill="none" aria-hidden="true">
      <ellipse cx="20" cy="26" rx="15" ry="17" stroke="currentColor" strokeWidth="2" />
      <ellipse cx="20" cy="26" rx="10" ry="11.5" stroke="currentColor" strokeWidth="1.4" opacity="0.65" />
      <ellipse cx="20" cy="26" rx="5" ry="6" stroke="currentColor" strokeWidth="1.2" opacity="0.45" />
      <circle cx="20" cy="26" r="1.8" fill="currentColor" />
      <path d="M20 9v3M20 40v3M5 26h3M32 26h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.55" />
    </svg>
  );
}

function ProtocolSampleCard({ label, value, selected, onSelect }: {
  label: string;
  value: SampleType;
  selected: boolean;
  onSelect: () => void;
}) {
  const testId = value === 'Sashibo Core' ? 'sc' : 'tc';
  const Icon = value === 'Sashibo Core' ? SashiboCoreIcon : TailCutIcon;
  return (
    <button
      type="button"
      data-testid={`button-sample-${testId}`}
      onClick={onSelect}
      className={`btn-card focus-ring group relative flex min-h-[78px] w-full flex-col items-center justify-center gap-1 border px-1 py-2 text-center transition sm:min-h-[84px] sm:gap-1.5 ${
        selected
          ? 'navy-sheen border-transparent text-white shadow-[0_8px_22px_rgba(37,99,235,.28)]'
          : 'border-[#b8c4d4] bg-white text-[#0a1f44] hover:border-[#4169e1] hover:bg-[#f8fbff]'
      }`}
    >
      {selected && (
        <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-md border border-white/30 bg-white/15 text-white sm:right-1.5 sm:top-1.5">
          <Check size={10} strokeWidth={3} />
        </span>
      )}
      <Icon className={`h-9 w-7 transition-colors sm:h-10 sm:w-8 ${selected ? 'text-white' : 'text-[#2563eb] group-hover:text-[#1e40af]'}`} />
      <span className="text-[9px] font-extrabold uppercase tracking-[.06em] leading-tight sm:text-[10px]">
        {label}
      </span>
    </button>
  );
}

function VisionAdjustPanel({ adjustments, filter, onChange, onApply, onClose }: {
  adjustments: ImageAdjustments;
  filter: string;
  onChange: (patch: Partial<ImageAdjustments>) => void;
  onApply: (next: ImageAdjustments) => void;
  onClose: () => void;
}) {
  const sliders: { key: keyof ImageAdjustments; label: string; min: number; max: number; step?: number; unit?: string }[] = [
    { key: 'brightness', label: 'Brightness', min: 50, max: 150 },
    { key: 'contrast', label: 'Contrast', min: 50, max: 150 },
    { key: 'saturation', label: 'Saturation', min: 0, max: 180 },
    { key: 'exposure', label: 'Exposure', min: -30, max: 30 },
    { key: 'warmth', label: 'Warmth', min: -40, max: 40 },
    { key: 'sharpness', label: 'Sharpness', min: 0, max: 50 },
    { key: 'gamma', label: 'Gamma', min: 0.7, max: 1.4, step: 0.01 },
  ];

  const presets = [
    { id: 'human', label: 'Human eye', desc: 'Natural indoor inspection', values: HUMAN_EYE_PRESET },
    { id: 'warm', label: 'Warm indoor', desc: 'Tungsten / market lighting', values: INDOOR_WARM_PRESET },
    { id: 'bright', label: 'Bright overhead', desc: 'Strong white lighting', values: BRIGHT_OVERHEAD_PRESET },
  ] as const;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#0a1f44]/50 p-0 backdrop-blur-sm sm:items-center sm:p-4">
      <div className="modal-in flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-[#e2e8f0] bg-white shadow-[0_24px_80px_rgba(10,31,68,.2)] sm:rounded-2xl">
        <div className="flex items-start justify-between border-b border-[#f1f5f9] px-4 py-3 sm:px-5">
          <div>
            <p className="console-eyebrow">Vision calibration</p>
            <h2 className="mt-0.5 text-[16px] font-extrabold tracking-[-.02em] text-[#0a1f44]">Match the human eye</h2>
            <p className="mt-1 text-[10px] text-[#64748b]">Tune live preview and captured photos to match what graders see on the bench.</p>
          </div>
          <button type="button" onClick={onClose} className="focus-ring flex size-8 items-center justify-center rounded-lg border border-[#e2e8f0] text-[#64748b] hover:bg-[#f8fafc]"><X size={16} /></button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-5">
          <div className="mb-3 overflow-hidden rounded-xl border border-[#e2e8f0] bg-[#0f172a]">
            <div className="relative aspect-video w-full overflow-hidden">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_40%,#fda4af,#fb7185_35%,#881337_100%)]" style={{ filter }} />
              <div className="absolute inset-3 rounded-lg border border-white/30">
                <span className="absolute left-2 top-2 text-[8px] font-bold uppercase tracking-[.1em] text-white/70">Live preview</span>
              </div>
            </div>
          </div>

          <p className="mb-2 text-[9px] font-extrabold uppercase tracking-[.1em] text-[#94a3b8]">Quick presets</p>
          <div className="mb-4 grid gap-2">
            {presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                data-testid={`button-vision-preset-${preset.id}`}
                onClick={() => onApply(preset.values)}
                className="focus-ring flex items-center gap-3 rounded-xl border border-[#e2e8f0] bg-[#f8fafc] px-3 py-2.5 text-left hover:border-[#2563eb]/40 hover:bg-[#eff6ff]"
              >
                <span className="flex size-8 items-center justify-center rounded-lg navy-sheen text-white"><Eye size={14} /></span>
                <span>
                  <span className="block text-[11px] font-extrabold text-[#0a1f44]">{preset.label}</span>
                  <span className="block text-[9px] text-[#64748b]">{preset.desc}</span>
                </span>
              </button>
            ))}
          </div>

          <p className="mb-2 text-[9px] font-extrabold uppercase tracking-[.1em] text-[#94a3b8]">Fine tune</p>
          <div className="space-y-3">
            {sliders.map((slider) => (
              <label key={slider.key} className="block">
                <div className="mb-1 flex items-center justify-between text-[10px] font-bold text-[#475569]">
                  <span className="flex items-center gap-1.5">
                    {slider.key === 'brightness' || slider.key === 'exposure' ? <Sun size={11} /> : slider.key === 'contrast' || slider.key === 'sharpness' ? <Contrast size={11} /> : <SlidersHorizontal size={11} />}
                    {slider.label}
                  </span>
                  <span className="mono text-[#2563eb]">{adjustments[slider.key]}{slider.unit ?? (slider.key === 'gamma' ? '' : slider.key === 'exposure' || slider.key === 'warmth' ? '' : '%')}</span>
                </div>
                <input
                  type="range"
                  min={slider.min}
                  max={slider.max}
                  step={slider.step ?? 1}
                  value={adjustments[slider.key]}
                  onChange={(event) => onChange({ [slider.key]: Number(event.target.value) })}
                  className="vision-slider w-full"
                  data-testid={`slider-vision-${slider.key}`}
                />
              </label>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-[#f1f5f9] px-4 py-3 sm:px-5">
          <button
            type="button"
            data-testid="button-vision-reset"
            onClick={() => onApply(DEFAULT_IMAGE_ADJUSTMENTS)}
            className="focus-ring flex items-center gap-1.5 rounded-lg border border-[#e2e8f0] px-3 py-2 text-[10px] font-extrabold text-[#475569] hover:bg-[#f8fafc]"
          >
            <RotateCcw size={12} /> Reset to camera
          </button>
          <button type="button" onClick={onClose} className="focus-ring navy-sheen rounded-lg px-4 py-2 text-[11px] font-extrabold text-white shadow-sm">
            Apply to live view
          </button>
        </div>
      </div>
    </div>
  );
}

function CameraEmpty({ state, issue, onRetry }: { state: CameraState; issue?: string; onRetry: () => void }) {
  const isError = state === 'denied' || state === 'missing' || state === 'timeout';
  const text = state === 'loading' ? 'Connecting to camera…'
    : state === 'idle' ? 'Camera is not connected'
    : state === 'timeout' ? 'Camera connection timed out'
    : state === 'denied' ? 'Camera permission needed'
    : 'No camera detected';
  const detail = issue
    || (state === 'denied' ? 'Allow camera access in your browser, then try again.'
    : state === 'timeout' ? 'The camera took too long to respond. Make sure the webcam is connected and not in use by another app.'
    : state === 'missing' ? 'This browser does not expose a camera API. Use a supported webcam on HTTPS or localhost.'
    : 'Press Connect camera, allow access, frame the sample, then capture manually.');

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-[radial-gradient(circle_at_50%_36%,#eef2ff,#dce4f7)]">
      <div className="max-w-80 px-4 text-center">
        <div className={`mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl border border-white/80 bg-white/70 shadow-sm sm:size-14 ${isError ? 'text-[#c75a50]' : 'text-[#3f5fd0]'}`}>
          {state === 'loading' ? <RefreshCw className="animate-spin" size={22} /> : isError ? <AlertTriangle size={22} /> : <Video size={22} />}
        </div>
        <p className="text-[12px] font-extrabold text-[#3f507a] sm:text-[13px]">{text}</p>
        <p className="mt-1 text-[9px] leading-4 text-[#7180a3] sm:text-[10px]">{detail}</p>
        {state !== 'loading' && (
          <button
            type="button"
            data-testid="button-camera-retry"
            onClick={onRetry}
            className="focus-ring mt-3 capture-button navy-sheen rounded-lg px-4 py-2 text-[10px] font-extrabold text-white sm:py-2.5"
          >
            {state === 'idle' ? 'Connect camera' : 'Try camera again'}
          </button>
        )}
      </div>
    </div>
  );
}

function NewSampleModal({ onConfirm, onClose }: { onConfirm: () => void; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#0a1f44]/55 p-4 backdrop-blur-sm">
      <div className="modal-in w-full max-w-sm overflow-hidden rounded-2xl border border-[#e2e8f0] bg-white shadow-[0_24px_80px_rgba(10,31,68,.22)]">
        <div className="navy-sheen px-5 py-4 text-center">
          <p className="text-[10px] font-bold uppercase tracking-[.14em] text-white/70">Rotation cycle complete</p>
          <h2 className="mt-1 text-[24px] font-extrabold tracking-[-.03em] text-white sm:text-[28px]">New sample?</h2>
        </div>
        <div className="space-y-3 px-5 py-4 text-center">
          <p className="text-[11px] leading-5 text-[#5c7587]">All six sides are captured. Start a fresh sample and reset back to Side 1.</p>
          <button
            type="button"
            data-testid="button-new-sample-confirm"
            onClick={onConfirm}
            className="capture-button focus-ring navy-sheen w-full rounded-xl px-4 py-3 text-[12px] font-extrabold text-white"
          >
            Start new sample
          </button>
          <p className="mono text-[9px] font-bold uppercase tracking-[.12em] text-[#94a3b8]">Press Spacebar</p>
          <button type="button" onClick={onClose} className="focus-ring text-[10px] font-bold text-[#94a3b8] hover:text-[#64748b]">Cancel</button>
        </div>
      </div>
    </div>
  );
}

function GradeModal({ image, error, onSelect, onCancel }: { image?: string; error?: string; onSelect: (grade: Grade) => void; onCancel: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-[#18354a]/50 p-0 backdrop-blur-md sm:items-center sm:p-4">
      <div className="modal-in flex max-h-[95dvh] w-full flex-col overflow-hidden rounded-t-3xl border border-white/80 bg-[#f9fcfd] shadow-[0_30px_90px_rgba(20,58,86,.32)] sm:max-w-160 sm:rounded-3xl">
        <div className="relative flex items-start justify-between border-b border-[#e4edf2] bg-linear-to-r from-white/90 to-[#f2f9fc] px-4 py-3 sm:px-5 sm:py-4 md:px-6">
          <div>
            <p className="eyebrow text-[#288bab]">Capture held · label required</p>
            <h2 className="mt-1 text-[17px] font-extrabold tracking-[-.04em] text-[#1f3c52] sm:text-[20px]">How would you grade this sample?</h2>
            <p className="mt-1 text-[10px] text-[#77909e] sm:text-[11px]">Choose one label to save the image and continue.</p>
          </div>
          <div className="hidden rounded-xl border border-[#d9edf5] bg-white p-2 text-[#299ac4] shadow-sm sm:block"><ClipboardList size={18} /></div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid gap-3.5 p-4 sm:grid-cols-[170px_1fr] sm:gap-4 sm:p-5 md:p-6">
            <div className={`pop-in relative ${image ? 'overflow-hidden rounded-[18px] border-4 border-white shadow-[0_16px_38px_rgba(20,58,86,.22)]' : ''}`}>
              {image
                ? <>
                    <img src={image} alt="Captured tuna sample awaiting grade" className="aspect-square w-full object-cover" />
                    <span className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-full bg-[#193b4d]/70 px-2 py-1 text-[7px] font-extrabold uppercase tracking-[.12em] text-white backdrop-blur-sm">
                      <span className="live-dot size-1.5 rounded-full bg-[#62dded]" /> Awaiting grade
                    </span>
                  </>
                : <div className="flex aspect-square items-center justify-center rounded-[15px] bg-[#eaf1f5] text-[#7a98aa]"><ImageIcon /></div>
              }
            </div>
            <div className="grid grid-cols-2 gap-2 sm:gap-2.5">
              {grades.map((grade, index) => (
                <button
                  type="button"
                  key={grade}
                  data-testid={`button-grade-${grade.toLowerCase()}`}
                  onClick={() => onSelect(grade)}
                  className="focus-ring flex min-h-15 items-center justify-between gap-3 rounded-[14px] border border-[#e2e8f0] bg-white px-3 py-2.5 text-left transition-colors hover:border-[#9fc6d8] hover:bg-[#f7fbfd] sm:min-h-17 sm:px-4"
                >
                  <span className="flex items-center gap-2.5">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg text-[12px] font-extrabold text-white sm:size-8" style={{ background: gradeColors[grade] }}>{grade === 'Invalid' ? '!' : grade}</span>
                    <span className="text-[11px] font-bold text-[#334155] sm:text-[12px]">{gradeLabels[grade]}</span>
                  </span>
                  <span className="mono rounded-md bg-[#f1f5f9] px-1.5 py-0.5 text-[9px] font-medium text-[#94a3b8]">{index + 1}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Error banner inside grade modal */}
          {error && (
            <div className="mx-4 mb-3 flex items-start gap-2 rounded-[14px] border border-[#f0b8b4] bg-[#fff1f0] p-3 sm:mx-5 md:mx-6">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-[#c75a50]" />
              <p className="text-[10px] font-bold leading-4 text-[#a64843] sm:text-[11px]">{error}</p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-[#e4edf2] bg-linear-to-r from-[#f0f6f9] to-[#f7fafc] px-4 py-2.5 text-[9px] text-[#78909e] sm:px-5 sm:py-3 sm:text-[10px] md:px-6">
          <span className="hidden items-center gap-2 sm:flex"><Zap size={13} className="text-[#2aa4ce]" /> Keyboard ready: 1 / 2 / 3 / 4</span>
          <span className="text-[9px] sm:hidden">Tap a grade to save</span>
          <button type="button" data-testid="button-cancel-capture" onClick={onCancel} className="focus-ring rounded-lg px-2 py-1 font-bold text-[#6d8493] transition hover:bg-white hover:text-[#c75a50]">Discard frame</button>
        </div>
      </div>
    </div>
  );
}

function ReviewModal({ records, previews, exporting, overriding, onClose, onDelete, onOverrideGrade, onAnnotationUpdate, onExport, onDownload, onTypeOverride }: { records: RecordItem[]; previews: Record<string, string>; exporting: boolean; overriding: boolean; onClose: () => void; onDelete: (id: string) => void; onOverrideGrade: (id: string, grade: Grade) => void; onAnnotationUpdate: (id: string, annotations: string[]) => void; onTypeOverride: (id: string, sampleType: SampleType) => void; onExport: (format: 'csv' | 'json') => void; onDownload: () => void }) {
  const [selectedId, setSelectedId] = useState('');
  const [gradeFilter, setGradeFilter] = useState<Grade | 'All'>('All');
  const [sampleTypeFilter, setSampleTypeFilter] = useState<'Sashibo Core' | 'Tail-Cut' | 'All'>('All');
  const [pendingGrade, setPendingGrade] = useState<Grade | ''>('');

  const gradeCounts = useMemo(() => {
    const counts: Record<Grade | 'All', number> = { All: records.length, A: 0, B: 0, C: 0, Invalid: 0 };
    for (const record of records) counts[record.grade] += 1;
    return counts;
  }, [records]);

  const filteredRecords = useMemo(() => {
    if (gradeFilter === 'All' && sampleTypeFilter === 'All') return records;
    if (gradeFilter === 'All') return records.filter((record) => record.sampleType === sampleTypeFilter);
    if (sampleTypeFilter === 'All') return records.filter((record) => record.grade === gradeFilter);
    return records.filter((record) => record.sampleType === sampleTypeFilter && record.grade === gradeFilter);
  }, [records, gradeFilter, sampleTypeFilter]);

  useEffect(() => {
    if (selectedId && !records.some((record) => record.id === selectedId)) {
      setSelectedId('');
    }
  }, [records, selectedId]);

  const selectedRecord = selectedId ? records.find((record) => record.id === selectedId) : undefined;
  const inDetail = Boolean(selectedRecord);

  useEffect(() => {
    setPendingGrade('');
  }, [selectedRecord?.id]);

  useEffect(() => {
    const handleModalKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && inDetail) {
        event.stopPropagation();
        setSelectedId('');
      }
    };
    window.addEventListener('keydown', handleModalKey, { capture: true });
    return () => window.removeEventListener('keydown', handleModalKey, { capture: true });
  }, [inDetail]);

  const [bboxId, setBboxOpen] = useState('');
  const bboxRecord = bboxId ? records.find((record) => record.id === bboxId) : undefined;

  const handleDelete = (id: string) => {
    onDelete(id);
    if (selectedId === id) setSelectedId('');
  };

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/40 p-0 backdrop-blur-[2px] sm:items-center sm:p-3 md:p-4">
      <div className="review-modal modal-in flex max-h-dvh w-full flex-col overflow-hidden rounded-t-3xl border border-[#ebebeb] bg-white shadow-[0_24px_80px_rgba(15,23,42,.14)] sm:max-h-[min(900px,94dvh)] sm:max-w-295 sm:rounded-3xl">
        <div className="flex shrink-0 items-center justify-between border-b border-[#f0f0f0] bg-white px-3 py-3 sm:px-4 sm:py-4 md:px-6">
          <div className="min-w-0">
            {inDetail ? (
              <button
                type="button"
                data-testid="button-back-review"
                onClick={() => setSelectedId('')}
                className="focus-ring mb-1 flex items-center gap-1.5 rounded-lg px-1 py-0.5 text-[10px] font-bold text-[#64748b] transition hover:bg-[#f8fafc] hover:text-[#334155] sm:mb-2 sm:text-[11px]"
              >
                <ChevronLeft size={16} /> Back to gallery
              </button>
            ) : (
              <p className="eyebrow text-[#94a3b8]">Session archive</p>
            )}
            <h2 className="text-[16px] font-extrabold tracking-[-.03em] text-[#1e293b] sm:text-[18px] md:text-[20px]">
              {inDetail ? 'Capture details' : (
                <>Captured samples <span className="mono text-[#475569]">{filteredRecords.length}</span></>
              )}
            </h2>
            <p className="mt-0.5 text-[9px] text-[#94a3b8] sm:text-[10px]">
              {inDetail ? jpegFilename(selectedRecord!) : 'Tap any sample to open full metadata and the large preview.'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" data-testid="button-export-csv-review" onClick={() => onExport('csv')} className="focus-ring hidden items-center gap-1.5 rounded-lg border border-[#d1e1e8] bg-white px-2.5 py-2 text-[10px] font-bold text-[#527084] sm:flex">
              <Download size={13} /> CSV
            </button>
            <button type="button" data-testid="button-close-review" onClick={onClose} className="focus-ring rounded-lg p-2 text-[#94a3b8] transition hover:bg-[#f8fafc] hover:text-[#475569]">
              <X size={18} />
            </button>
          </div>
        </div>

        {!inDetail && records.length > 0 && (
          <div className="review-filters shrink-0 overflow-x-auto border-b border-[#f0f0f0] bg-[#fafafa] px-3 py-2.5 sm:px-4 sm:py-3 md:px-6">
            <div className="flex items-center gap-1.5 sm:flex-wrap sm:gap-2">
              <span className="mr-1 shrink-0 text-[8px] font-bold uppercase tracking-widest text-[#94a3b8] sm:text-[9px]">Filter</span>
              {(['All', ...grades] as const).map((filter) => {
                const active = gradeFilter === filter;
                const label = filter === 'All' ? 'All' : filter === 'Invalid' ? 'Inv' : `${filter}`;
                const fullLabel = filter === 'All' ? 'All' : filter === 'Invalid' ? 'Invalid' : `Grade ${filter}`;
                const count = gradeCounts[filter];
                return (
                  <button
                    key={filter}
                    type="button"
                    data-testid={`filter-grade-${filter.toLowerCase()}`}
                    onClick={() => setGradeFilter(filter)}
                    className={`focus-ring review-filter-pill shrink-0 ${active ? 'review-filter-pill-active' : ''}`}
                    style={active && filter !== 'All' ? { background: gradeColors[filter], borderColor: gradeColors[filter], color: '#fff' } : undefined}
                  >
                    <span className="sm:hidden">{label}</span>
                    <span className="hidden sm:inline">{fullLabel}</span>
                    <span className={`mono rounded-md px-1.5 py-0.5 text-[8px] sm:text-[9px] ${active && filter !== 'All' ? 'bg-white/20' : 'bg-[#f1f5f9] text-[#64748b]'}`}>
                      {count}
                    </span>
                  </button>
                );
              })}
              <span className="ml-2 shrink-0 text-[8px] font-bold uppercase tracking-widest text-[#94a3b8] sm:text-[9px]">Type</span>
              {(['All', 'Sashibo Core', 'Tail-Cut'] as const).map((type) => {
                const active = sampleTypeFilter === type;
                return (
                  <button
                    key={type}
                    type="button"
                    data-testid={`filter-type-${type.toLowerCase()}`}
                    onClick={() => setSampleTypeFilter(type)}
                    className={`focus-ring review-filter-pill shrink-0 ${active ? 'review-filter-pill-active' : ''} ${type === 'All' ? '' : 'ml-2'}`}
                  >
                    <span className="sm:hidden">{type}</span>
                    <span className="hidden sm:inline">{type}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

<div className="min-h-0 flex-1 overflow-y-auto">
          {!records.length ? (
            <div className="flex min-h-65 flex-col items-center justify-center px-4 py-8 text-center sm:min-h-70 sm:px-6 sm:py-12">
              <div className="mb-3 rounded-2xl bg-[#f8fafc] p-3 text-[#64748b] sm:p-4"><Archive size={24} /></div>
              <h3 className="text-[13px] font-extrabold text-[#334155] sm:text-[14px]">Nothing captured yet</h3>
              <p className="mt-1 max-w-65 text-[10px] leading-4 text-[#94a3b8] sm:text-[11px]">Completed samples will appear here for a quick quality check.</p>
            </div>
          ) : inDetail && selectedRecord ? (
            <div className="p-3 sm:p-4 md:p-6">
              <div className="grid gap-4 sm:gap-5 xl:grid-cols-[minmax(0,1.2fr)_340px]">
                <div>
                  <div className="overflow-hidden rounded-2xl border border-[#ececec] bg-[#fafafa] p-2 sm:rounded-[20px] sm:p-2.5">
                    <div className="aspect-4/3 w-full overflow-hidden rounded-[12px] sm:rounded-[14px]">
                      <ZoomableCaptureImage record={selectedRecord} previewUrl={previews[selectedRecord.id]} />
                    </div>
                    <p className="mt-1.5 text-center text-[8px] text-[#94a3b8] sm:text-[9px]">Hover to zoom · move cursor to inspect details</p>
                  </div>
                  <div className="mt-3 rounded-2xl border border-[#ececec] bg-white p-3 sm:mt-4 sm:rounded-[18px] sm:p-4">
                    <p className="eyebrow text-[#94a3b8]">Filename</p>
                    <p className="mt-1.5 break-all font-mono text-[11px] font-bold leading-5 text-[#1e293b] sm:mt-2 sm:text-[12px] md:text-[13px]">{jpegFilename(selectedRecord)}</p>
                    <div className="mt-3 border-t border-[#f1f5f9] pt-3">
                      <p className="eyebrow text-[#94a3b8]">Capture info</p>
                      <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                        {[
                          { label: 'Sample type', value: selectedRecord.sampleType },
                          { label: 'Current grade', value: gradeLabels[selectedRecord.grade] },
                          ...(selectedRecord.captureMode === 'rotation' ? [{ label: 'Capture mode', value: `Rotation pie · Side ${String(selectedRecord.rotationSide ?? 1).padStart(2, '0')}` }] : []),
                          { label: 'Collection site', value: selectedRecord.site },
                          { label: 'Capture date', value: selectedRecord.date },
                          { label: 'Sequence', value: String(selectedRecord.sequence).padStart(3, '0') },
                          { label: 'Created at', value: new Date(selectedRecord.createdAt).toLocaleString() },
                        ].map((item) => (
                          <div key={item.label} className="rounded-lg border border-[#f1f5f9] bg-[#fafafa] px-2.5 py-1.5 sm:px-3 sm:py-2">
                            <p className="text-[7px] font-bold uppercase tracking-[.08em] text-[#94a3b8] sm:text-[8px]">{item.label}</p>
                            <p className="mt-0.5 text-[9px] font-extrabold text-[#334155] sm:text-[10px]">{item.value}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="overflow-hidden rounded-2xl border border-[#e2e8f0] bg-white shadow-sm">
                    <div className="flex items-center justify-between gap-2 border-b border-[#f1f5f9] px-3 py-2.5 sm:px-4">
                      <p className="text-[9px] font-extrabold uppercase tracking-[.1em] text-[#64748b] sm:text-[10px]">Manual grade override</p>
                      {selectedRecord.originalGrade && selectedRecord.originalGrade !== selectedRecord.grade ? (
                        <span data-testid="badge-overridden" className="flex shrink-0 items-center gap-1 rounded-full bg-[#fff7ec] px-2 py-0.5 text-[7px] font-extrabold uppercase tracking-[.08em] text-[#b98a49] sm:text-[8px]"><PenLine size={10} /> Overridden</span>
                      ) : (
                        <span className="shrink-0 rounded-full bg-[#f1f5f9] px-2 py-0.5 text-[7px] font-extrabold uppercase tracking-[.08em] text-[#94a3b8] sm:text-[8px]">As captured</span>
                      )}
                    </div>
                    <div className="p-3 sm:p-4">
                      <div className="flex items-center justify-between rounded-lg border border-[#e8edf2] bg-[#f8fafc] px-3 py-2">
                        <span className="text-[8px] font-bold uppercase tracking-[.08em] text-[#94a3b8] sm:text-[9px]">Current grade</span>
                        <span className="flex items-center gap-1.5 text-[10px] font-extrabold text-[#334155] sm:text-[11px]">
                          <span className="size-2.5 rounded-full" style={{ background: gradeColors[selectedRecord.grade] }} />
                          {gradeLabels[selectedRecord.grade]}
                        </span>
                      </div>

                      <div className="mt-2 grid grid-cols-4 gap-1.5 sm:gap-2" onMouseLeave={() => setPendingGrade('')}>
                        {grades.map((grade) => {
                          const active = selectedRecord.grade === grade;
                          const useRoyal = active && grade !== 'Invalid';
                          return (
                            <button
                              type="button"
                              key={grade}
                              data-testid={`button-override-${grade.toLowerCase()}`}
                              disabled={active || overriding}
                              onClick={() => onOverrideGrade(selectedRecord.id, grade)}
                              onMouseEnter={() => setPendingGrade(active ? '' : grade)}
                              onFocus={() => setPendingGrade(active ? '' : grade)}
                              onBlur={() => setPendingGrade('')}
                              className={`btn-card focus-ring relative flex min-h-[3.25rem] flex-col items-center justify-center gap-0.5 border py-2 text-center transition disabled:cursor-default sm:min-h-14 ${
                                active
                                  ? `${useRoyal ? 'navy-sheen' : ''} border-transparent text-white shadow-[0_6px_16px_rgba(37,99,235,.22)]`
                                  : 'border-[#d8e0ea] bg-white hover:border-[#4169e1]/45 hover:bg-[#f8fbff] disabled:opacity-50'
                              }`}
                              style={active && !useRoyal ? { background: gradeColors[grade] } : undefined}
                            >
                              {active && <Check size={11} className="absolute right-1 top-1" />}
                              {!active && <span className="size-2 rounded-full" style={{ background: gradeColors[grade] }} />}
                              <span className={`text-[12px] font-extrabold leading-none ${active ? 'text-white' : 'text-[#334155]'}`}>{grade === 'Invalid' ? '!' : grade}</span>
                              <span className={`text-[6px] font-bold uppercase tracking-[.08em] ${active ? 'text-white/75' : 'text-[#94a3b8]'}`}>{active ? 'Current' : 'Set'}</span>
                            </button>
                          );
                        })}
                      </div>

                      <div className="mt-2 rounded-lg border border-[#eef2f7] bg-[#f8fafc] px-2.5 py-2" data-testid="preview-rename">
                        {pendingGrade ? (
                          <p className="break-all font-mono text-[8px] leading-4 text-[#475569] sm:text-[9px]">
                            → <span className="font-bold">{buildFilename(selectedRecord.site, selectedRecord.sampleType, pendingGrade, selectedRecord.sequence, selectedRecord.date)}</span>
                          </p>
                        ) : (
                          <p className="text-[8px] leading-4 text-[#94a3b8] sm:text-[9px]">Hover a grade to preview the renamed file.</p>
                        )}
                      </div>

                      {selectedRecord.originalGrade && selectedRecord.originalGrade !== selectedRecord.grade && (
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[#f8fafc] px-2.5 py-2">
                          <p className="text-[8px] font-bold text-[#94a3b8] sm:text-[9px]">
                            Was {gradeLabels[selectedRecord.originalGrade]}
                          </p>
                          <button
                            type="button"
                            data-testid="button-revert-grade"
                            disabled={overriding}
                            onClick={() => onOverrideGrade(selectedRecord.id, selectedRecord.originalGrade!)}
                            className="focus-ring flex shrink-0 items-center gap-1 rounded-lg border border-[#e2e8f0] bg-white px-2 py-1 text-[8px] font-extrabold text-[#527084] transition hover:bg-[#f8fafc] disabled:opacity-50 sm:text-[9px]"
                          >
                            <RotateCcw size={10} /> Revert
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="overflow-hidden rounded-2xl border border-[#e2e8f0] bg-white p-3 shadow-sm sm:p-3.5">
                    <p className="text-[9px] font-extrabold uppercase tracking-[.1em] text-[#64748b] sm:text-[10px]">Type override</p>
                    <div className="mt-2 grid grid-cols-2 gap-1.5">
                      {(['Sashibo Core', 'Tail-Cut'] as SampleType[]).map((type) => {
                        const active = selectedRecord.sampleType === type;
                        const code = type === 'Sashibo Core' ? 'sc' : 'tc';
                        const label = type === 'Sashibo Core' ? 'Sashibo-Core' : 'Tail-Cut';
                        return (
                          <button
                            key={type}
                            type="button"
                            data-testid={`button-type-override-${code}`}
                            onClick={() => !active && onTypeOverride(selectedRecord.id, type)}
                            className={`btn-card focus-ring relative flex min-h-[3rem] flex-col items-center justify-center gap-1 border px-2 py-2 text-center transition sm:min-h-[3.25rem] ${
                              active
                                ? 'navy-sheen border-transparent text-white shadow-[0_6px_16px_rgba(37,99,235,.22)]'
                                : 'border-[#d8e0ea] bg-white text-[#334155] hover:border-[#4169e1]/45 hover:bg-[#f8fbff]'
                            }`}
                          >
                            {active && <Check size={11} className="absolute right-1 top-1 text-white" />}
                            <span className={`text-[10px] font-extrabold uppercase tracking-[.05em] ${active ? 'text-white' : 'text-[#0a1f44]'}`}>{label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <button
                    type="button"
                    data-testid="button-bbox-annotation"
                    onClick={() => setBboxOpen(selectedRecord.id)}
                    className="focus-ring flex w-full items-center justify-center gap-1.5 rounded-xl border border-[#d5e5ee] bg-[#f7fbfd] px-3 py-2.5 text-[10px] font-extrabold text-[#3b7a9e] hover:border-[#7bc7e5] sm:text-[11px]"
                  >
                    <BoxSelect size={13} /> Annotate determinants
                  </button>

                  <button
                    type="button"
                    data-testid={`button-delete-record-${selectedRecord.id}`}
                    onClick={() => handleDelete(selectedRecord.id)}
                    className="focus-ring flex w-full items-center justify-center gap-2 rounded-[14px] border border-[#f0d4c2] bg-[#fff7f1] px-4 py-2.5 text-[10px] font-extrabold text-[#b0634f] hover:bg-[#fff2ea] sm:rounded-2xl sm:py-3 sm:text-[11px]"
                  >
                    <Trash2 size={15} /> Delete this capture
                  </button>

                  {parseBboxAnnotations(selectedRecord.annotations).length > 0 && (
                    <div className="rounded-2xl border border-[#e6f7ff] bg-[#f0f7ff] px-3 py-2.5 sm:rounded-[18px] sm:p-3">
                      <p className="text-[8px] font-bold uppercase tracking-[.06em] text-[#2185ae] sm:text-[9px]">Region labels</p>
                      <div className="mt-1.5 max-h-40 space-y-1 overflow-y-auto">
                        {parseBboxAnnotations(selectedRecord.annotations).map((box) => (
                          <div key={box.id} className="flex items-center gap-2 rounded-lg border border-white bg-white px-2 py-1.5 text-[8px] sm:text-[9px]">
                            <span className="size-2.5 shrink-0 rounded-full" style={{ background: gradeColors[box.grade] }} />
                            <span className="min-w-0 flex-1">
                              <span className="font-semibold text-[#334155]">{box.category}</span>
                              <span className="block text-[#64748b]">{box.label}</span>
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                const remaining = (selectedRecord.annotations ?? []).filter((item) => {
                                  if (!item.startsWith('bbox:')) return true;
                                  const parsed = parseBboxAnnotations([item])[0];
                                  return parsed?.id !== box.id;
                                });
                                onAnnotationUpdate(selectedRecord.id, remaining);
                              }}
                              className="text-[#888888] hover:text-[#c75a50]"
                            ><X size={12} /></button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : filteredRecords.length ? (
            <div className="review-gallery space-y-4 p-3 sm:space-y-5 sm:p-4 md:p-6">
              {(['Sashibo Core', 'Tail-Cut'] as SampleType[]).map((type) => {
                const typeRecords = filteredRecords.filter((record) => record.sampleType === type);
                if (!typeRecords.length && (gradeFilter !== 'All' || sampleTypeFilter !== 'All')) return null;
                const folderName = type === 'Sashibo Core' ? 'Sashibo-Core' : 'Tail-Cut';
                return (
                  <div key={type} className="rounded-[18px] border border-[#e3edf3] bg-[#f8fbfc] p-3 sm:p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="rounded-lg bg-[#e3f4fc] p-1.5 text-[#2185ae]"><FolderOpen size={16} /></div>
                        <h3 className="text-[13px] font-extrabold text-[#203c53] sm:text-[14px]">{folderName}</h3>
                        <span className="mono rounded-full bg-[#eef5fa] px-2 py-0.5 text-[9px] font-bold text-[#5c7a8e]">
                          {typeRecords.length} capture{typeRecords.length === 1 ? '' : 's'}
                        </span>
                      </div>
                    </div>

                    {typeRecords.length ? (
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 md:grid-cols-4 lg:grid-cols-5">
                        {typeRecords.map((record) => (
                          <button
                            type="button"
                            key={record.id}
                            data-testid={`card-record-${record.id}`}
                            onClick={() => setSelectedId(record.id)}
                            className="btn-card review-gallery-card focus-ring group text-left"
                          >
                            <div className="relative aspect-square overflow-hidden rounded-lg bg-[#f1f5f9]">
                              <RecordThumbnail record={record} previewUrl={previews[record.id]} />
                              <span
                                className="absolute left-1.5 top-1.5 rounded-full px-1.5 py-0.5 text-[7px] font-extrabold text-white shadow-sm sm:left-2 sm:top-2 sm:px-2 sm:text-[8px]"
                                style={{ background: gradeColors[record.grade] }}
                              >
                                {record.grade === 'Invalid' ? '!' : record.grade}
                              </span>
                              <span className="absolute bottom-1.5 right-1.5 rounded-md bg-white/90 px-1 py-0.5 font-mono text-[7px] font-bold text-[#475569] shadow-sm backdrop-blur-sm sm:bottom-2 sm:right-2 sm:px-1.5 sm:text-[8px]">
                                #{String(record.sequence).padStart(3, '0')}
                              </span>
                            </div>
                            <div className="mt-1.5 px-0.5 sm:mt-2">
                              <p className="truncate font-mono text-[8px] font-bold text-[#334155] sm:text-[9px]">{jpegFilename(record)}</p>
                              <p className="mt-0.5 truncate text-[7px] text-[#94a3b8] sm:text-[8px]">{record.sampleType}</p>
                            </div>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="py-2 text-[10px] text-[#94a3b8]">No {folderName} captures in this view.</p>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex min-h-60 flex-col items-center justify-center px-4 py-8 text-center sm:min-h-70 sm:px-6 sm:py-12">
              <div className="mb-3 rounded-2xl bg-[#f8fafc] p-3 text-[#94a3b8] sm:p-4"><SlidersHorizontal size={24} /></div>
              <h3 className="text-[13px] font-extrabold text-[#334155] sm:text-[14px]">No samples in this filter</h3>
              <p className="mt-1 max-w-60 text-[10px] leading-4 text-[#94a3b8] sm:text-[11px]">Try another grade or switch back to All.</p>
              <button type="button" onClick={() => setGradeFilter('All')} className="focus-ring mt-4 rounded-lg border border-[#e2e8f0] bg-white px-4 py-2 text-[10px] font-bold text-[#475569] hover:bg-[#f8fafc]">
                Show all captures
              </button>
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-[#f0f0f0] bg-[#fafafa] px-3 py-2.5 sm:px-4 sm:py-3 md:px-6">
          <span className="text-[9px] text-[#94a3b8] sm:text-[10px]">
            {inDetail ? 'Press Back to gallery to browse all captures.' : `${records.length} total · scroll to browse the archive`}
          </span>
          <div className="flex flex-wrap gap-1.5 sm:gap-2">
            <button type="button" data-testid="button-export-json-review" onClick={() => onExport('json')} className="focus-ring flex items-center gap-1.5 rounded-lg border border-[#d1e1e8] bg-white px-2.5 py-1.5 text-[9px] font-bold text-[#527084] sm:px-3 sm:py-2 sm:text-[10px]">
              <Download size={12} /> JSON
            </button>
            <button type="button" data-testid="button-download-dataset-review" disabled={!records.length || exporting} onClick={onDownload} className="capture-button navy-sheen focus-ring flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[9px] font-extrabold text-white disabled:opacity-40 sm:px-3 sm:py-2 sm:text-[10px]">
              <FileImage size={12} /> Download ZIP
            </button>
            <button type="button" data-testid="button-done-review" onClick={onClose} className="focus-ring rounded-lg border border-[#d1e1e8] bg-white px-3 py-1.5 text-[9px] font-extrabold text-[#214e69] sm:px-4 sm:py-2 sm:text-[10px]">
              Done
            </button>
          </div>
        </div>
      </div>
      {bboxRecord && (
        <DeterminantAnnotationModal
          record={bboxRecord}
          previewUrl={previews[bboxRecord.id]}
          onSave={(boxes) => {
            const notes = noteAnnotations(bboxRecord.annotations);
            onAnnotationUpdate(bboxRecord.id, [...boxes.map(serializeBboxAnnotation), ...notes]);
            setBboxOpen('');
          }}
          onClose={() => setBboxOpen('')}
        />
      )}
    </div>
  );
}

function EndModal({ records, settings, exporting, onClose, onConfirmEnd, onExport, onDownload }: { records: RecordItem[]; settings: SessionSettings; exporting: boolean; onClose: () => void; onConfirmEnd: () => void; onExport: (format: 'csv' | 'json') => void; onDownload: () => void }) {
  const sampleName = exampleFilename(settings.site);
  const [autoExportDone, setAutoExportDone] = useState(false);

  // Auto-export on mount
  useEffect(() => {
    if (records.length && !autoExportDone && !exporting) {
      setAutoExportDone(true);
      void onDownload();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-[#18354a]/40 p-0 backdrop-blur-sm sm:items-center sm:p-4">
      <div className="modal-in flex max-h-[95dvh] w-full flex-col overflow-hidden rounded-t-3xl border border-white/70 bg-[#f9fcfd] shadow-[0_25px_80px_rgba(20,58,86,.24)] sm:max-w-140 sm:rounded-[26px]">
        <div className="blue-sheen p-4 text-white sm:p-6">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[9px] font-bold uppercase tracking-[.14em] text-white/70 sm:text-[10px]">Session wrap</p>
              <h2 className="mt-1.5 text-[20px] font-extrabold tracking-tighter sm:mt-2 sm:text-[25px]">Secure the day's work.</h2>
              <p className="mt-1 text-[10px] text-white/75 sm:text-[11px]">
                {exporting ? 'Exporting your session…' : autoExportDone ? 'ZIP downloaded automatically! Extract it, then browse the folders.' : 'Download the ZIP, extract it, then browse tuncam / date-place / sample type / grade for the photos.'}
              </p>
            </div>
            <Archive size={24} className="shrink-0 text-white/80 sm:hidden" />
            <Archive size={27} className="hidden shrink-0 text-white/80 sm:block" />
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 sm:space-y-4 sm:p-6">
          <div className="grid grid-cols-3 gap-2">
            {[['Samples', records.length], ['Operator', settings.operator || '—'], ['Grader', settings.grader || '—']].map(([label, value]) => (
              <div key={String(label)} className="rounded-xl bg-[#eef6f9] p-2.5 sm:p-3">
                <p className="eyebrow">{label}</p>
                <p className="mt-0.5 truncate text-[11px] font-extrabold text-[#38566a] sm:mt-1 sm:text-[12px]">{value}</p>
              </div>
            ))}
          </div>
          <FilenamePreview name={sampleName} />
          <ol className="grid gap-2">
            {[
              'Right-click the ZIP → Extract All.',
              'Open tuncam > date-place > Tail-Cut or Sashibo-Core > GradeA (or B / C / Invalid).',
              'Double-click a .jpg to view it. Skip session-manifest.csv — that is a spreadsheet, not a photo.',
            ].map((step, index) => (
              <li key={step} className="flex gap-2.5 rounded-[12px] border border-[#dceaf1] bg-white/80 px-2.5 py-2 sm:gap-3 sm:rounded-[14px] sm:px-3 sm:py-2.5">
                <span className="mono flex size-5 shrink-0 items-center justify-center rounded-lg bg-[#e8f3ff] text-[9px] font-bold text-[#3d63cf] sm:size-6 sm:text-[10px]">{index + 1}</span>
                <p className="text-[10px] leading-4 text-[#4d6a7d] sm:text-[11px]">{step}</p>
              </li>
            ))}
          </ol>
          <div className="flex gap-2.5 rounded-[13px] border border-[#f0d9c8] bg-[#fff8f2] p-3 sm:gap-3 sm:rounded-[15px] sm:p-3.5">
            <Upload size={16} className="mt-0.5 shrink-0 text-[#d08362]" />
            <div>
              <p className="text-[10px] font-extrabold text-[#805846] sm:text-[11px]">Backup reminder</p>
              <p className="mt-0.5 text-[9px] leading-4 text-[#9e7662] sm:mt-1 sm:text-[10px]">Copy today's ZIP to a USB drive before leaving the landing center.</p>
            </div>
          </div>
          <button type="button" data-testid="button-download-dataset-end" disabled={!records.length || exporting} onClick={onDownload} className="capture-button navy-sheen focus-ring flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-[10px] font-extrabold text-white disabled:opacity-40 sm:py-3 sm:text-[11px]">
            <FileImage size={15} />{exporting ? 'Packing photos…' : autoExportDone ? 'Download photos ZIP again' : 'Download photos ZIP'}
          </button>
          <div className="flex gap-2">
            <button type="button" data-testid="button-export-csv-end" onClick={() => onExport('csv')} className="focus-ring flex flex-1 items-center justify-center gap-2 rounded-xl border border-[#cfe1e9] bg-white py-2 text-[9px] font-extrabold text-[#4f7185] sm:py-2.5 sm:text-[10px]"><Download size={13} /> CSV</button>
            <button type="button" data-testid="button-export-json-end" onClick={() => onExport('json')} className="focus-ring flex flex-1 items-center justify-center gap-2 rounded-xl border border-[#cfe1e9] bg-white py-2 text-[9px] font-extrabold text-[#4f7185] sm:py-2.5 sm:text-[10px]"><Download size={13} /> JSON</button>
          </div>
          <button
            type="button"
            data-testid="button-confirm-end-session"
            onClick={onConfirmEnd}
            className="focus-ring flex w-full items-center justify-center gap-2 rounded-xl bg-linear-to-r from-[#214e69] to-[#16384d] py-3 text-[11px] font-extrabold text-white shadow-[0_8px_20px_rgba(25,58,82,.24)] transition hover:from-[#1b4259] hover:to-[#102b3c] sm:py-3.5 sm:text-[12px]"
          >
            <Check size={16} /> CONFIRM END SESSION & CLEAR
          </button>
          <button
            type="button"
            data-testid="button-close-end"
            onClick={onClose}
            className="focus-ring w-full rounded-xl border border-[#d5e5ee] bg-white py-2.5 text-[10px] font-bold text-[#5c778a] hover:bg-[#f7fbfd] sm:py-3 sm:text-[11px]"
          >
            Back to session (keep capturing)
          </button>
        </div>
      </div>
    </div>
  );
}

function ToolsModal({ settings, onClose, onInstall }: { settings: SessionSettings; onClose: () => void; onInstall?: () => Promise<void> }) {
  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-[#18354a]/40 p-0 backdrop-blur-sm sm:items-center sm:p-4">
      <div className="modal-in w-full max-h-dvh overflow-y-auto rounded-t-3xl border border-white/70 bg-[#f9fcfd] p-4 shadow-[0_25px_80px_rgba(20,58,86,.24)] sm:max-w-115 sm:rounded-3xl sm:p-6">
        <div className="flex items-start justify-between">
          <div><p className="eyebrow">Session tools</p><h2 className="mt-1 text-[17px] font-extrabold text-[#203e54] sm:text-[19px]">Field instrument</h2></div>
          <button type="button" data-testid="button-close-tools" onClick={onClose} className="focus-ring rounded-lg p-2 text-[#78919f] hover:bg-white"><X size={18} /></button>
        </div>
        <div className="mt-4 space-y-2 sm:mt-5">
          <ToolRow icon={<CloudOff size={16} />} title="Offline-first storage" detail="Captures stay in this browser and optional local folder." />
          <ToolRow icon={<ShieldCheck size={16} />} title="No auto-detect" detail="Camera and shutter are manual only. Nothing captures itself." />
          <ToolRow icon={<FolderOpen size={16} />} title="Folder access" detail={settings.storage} />
        </div>
        {onInstall && <button type="button" data-testid="button-install-tools" onClick={onInstall} className="focus-ring mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-[#e7f6fb] py-2.5 text-[10px] font-extrabold text-[#257d9f] sm:mt-5 sm:py-3 sm:text-[11px]"><Download size={15} /> Install TUNCAM on this device</button>}
        <button type="button" data-testid="button-done-tools" onClick={onClose} className="focus-ring mt-2 w-full rounded-xl bg-[#214e69] py-2.5 text-[10px] font-extrabold text-white sm:py-3 sm:text-[11px]">Done</button>
      </div>
    </div>
  );
}

function ZoomableCaptureImage({ record }: { record: RecordItem; previewUrl?: string }) {
  const { url, error } = useRecordImageUrl(record.id);
  const [zooming, setZooming] = useState(false);
  const [origin, setOrigin] = useState({ x: 50, y: 50 });

  const handleMove = (event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setOrigin({
      x: ((event.clientX - rect.left) / rect.width) * 100,
      y: ((event.clientY - rect.top) / rect.height) * 100,
    });
  };

  if (error || !url) {
    return (
      <div className="flex size-full items-center justify-center bg-[#f1f5f9] text-[#94a3b8]">
        <ImageIcon size={22} className="opacity-60" />
      </div>
    );
  }

  return (
    <div
      className="zoom-capture relative size-full cursor-zoom-in overflow-hidden bg-[#0f172a]"
      onMouseEnter={() => setZooming(true)}
      onMouseLeave={() => setZooming(false)}
      onMouseMove={handleMove}
    >
      <img
        src={url}
        alt={jpegFilename(record)}
        draggable={false}
        className="size-full object-cover transition-transform duration-200 ease-out"
        style={{
          transform: zooming ? 'scale(2.2)' : 'scale(1)',
          transformOrigin: `${origin.x}% ${origin.y}%`,
        }}
      />
      {zooming && (
        <span className="pointer-events-none absolute bottom-2 right-2 rounded-full bg-black/55 px-2 py-0.5 text-[8px] font-bold text-white backdrop-blur">
          2.2× zoom
        </span>
      )}
    </div>
  );
}

function SquareCaptureOverlay({ crosshair, onCrosshairChange }: {
  crosshair: FramingCrosshairStyle;
  onCrosshairChange: (style: FramingCrosshairStyle) => void;
}) {
  const accentColor = '#8BA4FF';
  const [barOpen, setBarOpen] = useState(loadFramingCrosshairBarOpen);

  const toggleBar = () => {
    setBarOpen((open) => {
      const next = !open;
      try { localStorage.setItem(FRAMING_CROSSHAIR_BAR_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  };

  return (
    <div className="pointer-events-none absolute inset-0">
      <div className="absolute inset-[12%_10%] rounded-xl border border-white/75 shadow-[0_0_0_999px_rgba(12,28,42,.22)] sm:inset-[17%_16%] sm:rounded-2xl sm:border-white/85">
        <span className="absolute -left-px -top-px size-3 border-l-2 border-t-2 sm:size-3.5" style={{ borderColor: accentColor }} />
        <span className="absolute -right-px -top-px size-3 border-r-2 border-t-2 sm:size-3.5" style={{ borderColor: accentColor }} />
        <span className="absolute -bottom-px -left-px size-3 border-b-2 border-l-2 sm:size-3.5" style={{ borderColor: accentColor }} />
        <span className="absolute -bottom-px -right-px size-3 border-b-2 border-r-2 sm:size-3.5" style={{ borderColor: accentColor }} />
      </div>

      <FramingCrosshairGraphics style={crosshair} />

      {barOpen ? (
        <div className="framing-crosshair-bar pointer-events-auto absolute bottom-8 left-2 z-10 sm:bottom-9 sm:left-3">
          <div className="framing-crosshair-toolbar flex items-center gap-0.5 rounded-full border border-white/14 bg-[#0a1628]/88 p-0.5 shadow-[0_6px_20px_rgba(0,0,0,.35)] backdrop-blur-md">
            <div className="framing-crosshair-options flex flex-nowrap items-center gap-px">
              {FRAMING_CROSSHAIR_STYLES.map((style) => {
                const active = crosshair === style;
                return (
                  <button
                    key={style}
                    type="button"
                    data-testid={`button-crosshair-${style}`}
                    title={style === 'none' ? 'Frame only' : `${FRAMING_CROSSHAIR_LABELS[style]} crosshair`}
                    onClick={() => onCrosshairChange(style)}
                    className={`crosshair-option focus-ring px-1.5 py-0.5 text-[6px] font-bold uppercase leading-none tracking-[.03em] transition sm:px-[7px] sm:text-[6.5px] ${
                      active
                        ? 'crosshair-option-active navy-sheen text-white shadow-sm'
                        : 'text-white/70 hover:bg-white/10 hover:text-white'
                    }`}
                  >
                    {FRAMING_CROSSHAIR_LABELS[style]}
                  </button>
                );
              })}
            </div>
            <span className="mx-px h-3.5 w-px shrink-0 bg-white/15" aria-hidden />
            <button
              type="button"
              data-testid="button-hide-crosshair-bar"
              onClick={toggleBar}
              title="Hide crosshair bar"
              className="crosshair-option focus-ring flex size-5 shrink-0 items-center justify-center text-white/75 hover:bg-white/10 hover:text-white"
            >
              <EyeOff size={10} />
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          data-testid="button-show-crosshair-bar"
          onClick={toggleBar}
          title="Show crosshair bar"
          className="crosshair-option focus-ring pointer-events-auto absolute bottom-8 left-2 z-10 flex size-7 items-center justify-center rounded-full border border-white/14 bg-[#0a1628]/88 text-white/85 shadow-[0_6px_20px_rgba(0,0,0,.35)] backdrop-blur-md hover:bg-[#1e3a8a]/90 hover:text-white sm:bottom-9 sm:left-3"
        >
          <Eye size={14} />
        </button>
      )}
    </div>
  );
}

function RotationPieOverlay({ slices, current, complete, settings, onSettingsChange, onSelectSlice, onReset }: {
  slices: boolean[];
  current: number;
  complete: boolean;
  settings: RotationPieSettings;
  onSettingsChange: (patch: Partial<RotationPieSettings>) => void;
  onSelectSlice: (index: number) => void;
  onReset: () => void;
}) {
  const segmentCount = slices.length;
  const doneCount = slices.filter(Boolean).length;
  const hidePlaceholders = settings.hidePlaceholders;
  const [adjustOpen, setAdjustOpen] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null);
  const chamberRef = useRef<HTMLDivElement>(null);

  const size = 420;
  const cx = size / 2;
  const cy = size / 2;
  const innerR = size * 0.16;
  const outerR = size * 0.44;
  const segmentAngle = 360 / segmentCount;

  const describeDonutArc = (index: number) => {
    const start = (index * segmentAngle - 90) * (Math.PI / 180);
    const end = ((index + 1) * segmentAngle - 90) * (Math.PI / 180);
    const x1o = cx + outerR * Math.cos(start);
    const y1o = cy + outerR * Math.sin(start);
    const x2o = cx + outerR * Math.cos(end);
    const y2o = cy + outerR * Math.sin(end);
    const x1i = cx + innerR * Math.cos(end);
    const y1i = cy + innerR * Math.sin(end);
    const x2i = cx + innerR * Math.cos(start);
    const y2i = cy + innerR * Math.sin(start);
    const largeArc = segmentAngle > 180 ? 1 : 0;
    return `M ${x1o} ${y1o} A ${outerR} ${outerR} 0 ${largeArc} 1 ${x2o} ${y2o} L ${x1i} ${y1i} A ${innerR} ${innerR} 0 ${largeArc} 0 ${x2i} ${y2i} Z`;
  };

  const polar = (index: number, radius: number) => {
    const angle = ((index + 0.5) * segmentAngle - 90) * (Math.PI / 180);
    return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
  };

  const handleDragStart = (event: PointerEvent<HTMLDivElement>) => {
    if (!adjustOpen) return;
    dragRef.current = { startX: event.clientX, startY: event.clientY, ox: settings.offsetX, oy: settings.offsetY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleDragMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const rect = chamberRef.current?.getBoundingClientRect();
    if (!rect) return;
    const dx = ((event.clientX - dragRef.current.startX) / rect.width) * 100;
    const dy = ((event.clientY - dragRef.current.startY) / rect.height) * 100;
    onSettingsChange({
      offsetX: clamp(dragRef.current.ox + dx, -28, 28),
      offsetY: clamp(dragRef.current.oy + dy, -28, 28),
    });
  };

  const handleDragEnd = () => { dragRef.current = null; };

  const vignetteCenterX = 50 + settings.offsetX;
  const vignetteCenterY = 50 + settings.offsetY;
  const holeRadius = settings.scale * 24;

  return (
    <div ref={chamberRef} className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className="absolute inset-0 transition-[background] duration-200"
        style={{
          background: `radial-gradient(circle at ${vignetteCenterX}% ${vignetteCenterY}%, transparent ${holeRadius}%, rgba(12,36,52,${settings.dim * 0.7}) ${holeRadius + 2}%, rgba(8,22,34,${Math.min(0.92, settings.dim + 0.22)}) 100%)`,
        }}
      />

      {!hidePlaceholders && (
        <div className="pointer-events-none absolute left-1/2 top-2.5 z-10 flex -translate-x-1/2 items-center gap-2 sm:top-3">
          <div className="flex items-center gap-1.5 rounded-full border border-white/15 bg-[#153279]/90 px-2.5 py-1 text-[8px] font-extrabold uppercase tracking-[.1em] text-white shadow-lg backdrop-blur-md sm:text-[9px]">
            <RotateCw size={12} className="text-[#5B7FFF]" />
            Rotation · {doneCount}/{segmentCount}
          </div>
          {!complete && (
            <div className="rounded-full border border-[#4169E1]/50 bg-[#1e3a8a]/90 px-2.5 py-1 text-[8px] font-extrabold text-[#8BA4FF] shadow-lg backdrop-blur-md sm:text-[9px]">
              {ROTATION_LABELS[current]}
            </div>
          )}
          {complete && (
            <div className="rounded-full border border-[#4ade80]/40 bg-[#14532d]/85 px-2.5 py-1 text-[8px] font-extrabold text-[#86efac] shadow-lg backdrop-blur-md sm:text-[9px]">
              Cycle complete
            </div>
          )}
        </div>
      )}

      <div className="absolute inset-0 flex items-center justify-center">
        <div
          className={`pointer-events-auto relative w-[min(88vw,380px)] max-w-full transition-transform duration-150 ${adjustOpen ? 'cursor-move ring-2 ring-[#4169E1]/55 ring-offset-2 ring-offset-transparent rounded-full' : ''}`}
          style={{ transform: `translate(${settings.offsetX}%, ${settings.offsetY}%) scale(${settings.scale}) rotate(${settings.rotation}deg)` }}
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
          onPointerLeave={handleDragEnd}
        >
          <svg viewBox={`0 0 ${size} ${size}`} className="rotation-pie-svg w-full">
            <defs>
              <linearGradient id="pie-done" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#34d399" />
                <stop offset="100%" stopColor="#059669" />
              </linearGradient>
              <linearGradient id="pie-active" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#5B7FFF" />
                <stop offset="100%" stopColor="#1E40AF" />
              </linearGradient>
              <linearGradient id="pie-idle" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="rgba(255,255,255,0.16)" />
                <stop offset="100%" stopColor="rgba(255,255,255,0.06)" />
              </linearGradient>
              <filter id="pie-glow" x="-30%" y="-30%" width="160%" height="160%">
                <feGaussianBlur stdDeviation="4" result="blur" />
                <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
            </defs>

            {!hidePlaceholders && (
              <>
                <circle cx={cx} cy={cy} r={outerR + 10} fill="none" stroke="rgba(65,105,225,0.18)" strokeWidth="1.5" strokeDasharray="3 5" />
                <circle
                  cx={cx} cy={cy} r={outerR + 6} fill="none"
                  stroke="url(#pie-active)" strokeWidth="3"
                  strokeDasharray={`${(doneCount / segmentCount) * 2 * Math.PI * (outerR + 6)} ${2 * Math.PI * (outerR + 6)}`}
                  strokeLinecap="round"
                  transform={`rotate(-90 ${cx} ${cy})`}
                  opacity={0.85}
                />
              </>
            )}

            {slices.map((done, index) => {
              const isCurrent = index === current && !done;
              const label = polar(index, (innerR + outerR) / 2);
              const rim = polar(index, outerR + 18);
              return (
                <g key={index}>
                  <path
                    d={describeDonutArc(index)}
                    fill={done ? 'url(#pie-done)' : isCurrent ? 'url(#pie-active)' : 'url(#pie-idle)'}
                    stroke={isCurrent ? '#8BA4FF' : done ? '#6ee7b7' : 'rgba(255,255,255,0.22)'}
                    strokeWidth={isCurrent ? 2.5 : 1.2}
                    filter={isCurrent && !hidePlaceholders ? 'url(#pie-glow)' : undefined}
                    className="cursor-pointer transition-all duration-300"
                    onClick={() => onSelectSlice(index)}
                  />
                  {!hidePlaceholders && (
                    <>
                      <text
                        x={label.x} y={label.y}
                        textAnchor="middle" dominantBaseline="central"
                        fill={done || isCurrent ? '#fff' : 'rgba(255,255,255,0.65)'}
                        fontSize="20" fontWeight="800"
                      >
                        {done ? '✓' : index + 1}
                      </text>
                      <text
                        x={rim.x} y={rim.y}
                        textAnchor="middle" dominantBaseline="central"
                        fill={isCurrent ? '#8BA4FF' : done ? '#86efac' : 'rgba(255,255,255,0.35)'}
                        fontSize="8" fontWeight="700" letterSpacing="0.5"
                      >
                        {isCurrent ? 'NOW' : done ? 'DONE' : ''}
                      </text>
                    </>
                  )}
                </g>
              );
            })}

            {!hidePlaceholders && (
              <>
                <circle cx={cx} cy={cy} r={innerR} fill="rgba(8,28,42,0.72)" stroke="rgba(65,105,225,0.5)" strokeWidth="2" />
                <circle cx={cx} cy={cy} r={innerR * 0.62} fill="none" stroke="rgba(65,105,225,0.32)" strokeWidth="1" strokeDasharray="3 4" className="rotation-center-pulse" />
                <text x={cx} y={cy - 5} textAnchor="middle" fill="#5B7FFF" fontSize="9" fontWeight="800" letterSpacing="1.2">CENTER</text>
                <text x={cx} y={cy + 11} textAnchor="middle" fill="#fff" fontSize="12" fontWeight="800">{complete ? '✓' : `${doneCount}/${segmentCount}`}</text>
              </>
            )}
            <line x1={cx - (hidePlaceholders ? outerR : innerR * 0.75)} y1={cy} x2={cx + (hidePlaceholders ? outerR : innerR * 0.75)} y2={cy} stroke="rgba(65,105,225,0.55)" strokeWidth={hidePlaceholders ? 1.5 : 1} />
            <line x1={cx} y1={cy - (hidePlaceholders ? outerR : innerR * 0.75)} x2={cx} y2={cy + (hidePlaceholders ? outerR : innerR * 0.75)} stroke="rgba(65,105,225,0.55)" strokeWidth={hidePlaceholders ? 1.5 : 1} />
          </svg>
        </div>
      </div>

      <div className="pointer-events-auto absolute bottom-2 left-2 z-20 flex flex-col items-start gap-1 sm:bottom-3 sm:left-3">
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            data-testid="button-rotation-adjust"
            onClick={() => setAdjustOpen((open) => !open)}
            className={`focus-ring flex items-center gap-1 rounded-full border border-[#3b5bdb]/40 px-2 py-0.5 text-[7px] font-extrabold shadow-md backdrop-blur-md transition sm:text-[8px] ${adjustOpen ? 'navy-sheen text-white' : 'bg-[#153279]/95 text-white/90 hover:bg-[#1e3a8a]/95'}`}
          >
            <SlidersHorizontal size={10} />
            {adjustOpen ? 'Done' : 'Adjust guide'}
          </button>
          <button
            type="button"
            data-testid="button-rotation-hide-placeholders"
            onClick={() => onSettingsChange({ hidePlaceholders: !hidePlaceholders })}
            title={hidePlaceholders ? 'Show labels' : 'Hide labels'}
            className={`focus-ring flex items-center gap-1 rounded-full border border-[#3b5bdb]/40 px-1.5 py-0.5 text-[7px] font-extrabold shadow-md backdrop-blur-md transition sm:text-[8px] ${hidePlaceholders ? 'navy-sheen text-white' : 'bg-[#153279]/95 text-white/90 hover:bg-[#1e3a8a]/95'}`}
          >
            <Eye size={10} />
            <span className="sr-only">{hidePlaceholders ? 'Show labels' : 'Hide labels'}</span>
          </button>
          {complete && (
            <button type="button" onClick={onReset} className="focus-ring rounded-full border border-[#3b5bdb]/40 bg-[#153279]/95 px-2 py-0.5 text-[7px] font-extrabold text-white shadow-md backdrop-blur-md hover:bg-[#1e3a8a]/95 sm:text-[8px]">
              Reset
            </button>
          )}
        </div>

        {adjustOpen && (
          <div className="w-44 rounded-xl border border-[#3b5bdb]/35 bg-[#153279]/95 p-2 shadow-[0_8px_28px_rgba(10,31,68,.45)] backdrop-blur-md sm:w-48">
            <div className="space-y-2">
              <label className="block">
                <div className="mb-0.5 flex items-center justify-between text-[8px] font-bold text-white/75 sm:text-[9px]">
                  <span>Size</span>
                  <span className="mono text-[#8BA4FF]">{Math.round(settings.scale * 100)}%</span>
                </div>
                <input
                  type="range" min={55} max={110} step={1}
                  value={Math.round(settings.scale * 100)}
                  onChange={(event) => onSettingsChange({ scale: Number(event.target.value) / 100 })}
                  className="rotation-pie-slider w-full"
                  data-testid="slider-rotation-size"
                />
              </label>
              <label className="block">
                <div className="mb-0.5 flex items-center justify-between text-[8px] font-bold text-white/75 sm:text-[9px]">
                  <span>Rotation</span>
                  <span className="mono text-[#8BA4FF]">{settings.rotation}°</span>
                </div>
                <input
                  type="range" min={-180} max={180} step={1}
                  value={settings.rotation}
                  onChange={(event) => onSettingsChange({ rotation: Number(event.target.value) })}
                  className="rotation-pie-slider w-full"
                  data-testid="slider-rotation-angle"
                />
              </label>
              <label className="block">
                <div className="mb-0.5 flex items-center justify-between text-[8px] font-bold text-white/75 sm:text-[9px]">
                  <span>Background dim</span>
                  <span className="mono text-[#8BA4FF]">{Math.round(settings.dim * 100)}%</span>
                </div>
                <input
                  type="range" min={25} max={85} step={1}
                  value={Math.round(settings.dim * 100)}
                  onChange={(event) => onSettingsChange({ dim: Number(event.target.value) / 100 })}
                  className="rotation-pie-slider w-full"
                  data-testid="slider-rotation-dim"
                />
              </label>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="flex items-center gap-1 text-[7px] font-bold text-white/55 sm:text-[8px]"><Move size={10} /> Drag pie to reposition</span>
                <button
                  type="button"
                  data-testid="button-rotation-reset-layout"
                  onClick={() => onSettingsChange(DEFAULT_ROTATION_PIE_SETTINGS)}
                  className="focus-ring ml-auto rounded-md border border-white/15 bg-white/8 px-2 py-0.5 text-[7px] font-extrabold text-white/80 hover:bg-white/15 sm:text-[8px]"
                >
                  Reset layout
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DeterminantAnnotationModal({ record, previewUrl, onSave, onClose }: {
  record: RecordItem;
  previewUrl?: string;
  onSave: (boxes: BboxAnnotation[]) => void;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { url, error: imageError } = useRecordImageUrl(record.id);
  const [boxes, setBoxes] = useState<BboxAnnotation[]>(() => parseBboxAnnotations(record.annotations));
  const [viewGrade, setViewGrade] = useState<Grade>(record.grade);
  const [pendingDeterminant, setPendingDeterminant] = useState<Determinant | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const drawStart = useRef<{ x: number; y: number } | null>(null);
  const drawing = useRef(false);

  const grouped = useMemo(() => determinantsByCategory(record.sampleType, viewGrade), [record.sampleType, viewGrade]);
  const differentials = DIFFERENTIAL_NOTES[record.sampleType];

  const toPercent = (clientX: number, clientY: number) => {
    const rect = containerRef.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100)),
      y: Math.max(0, Math.min(100, ((clientY - rect.top) / rect.height) * 100)),
    };
  };

  const applyDeterminant = (det: Determinant) => {
    if (draft && draft.w >= 2 && draft.h >= 2) {
      const box: BboxAnnotation = {
        id: `${Date.now()}`,
        x: draft.x, y: draft.y, w: draft.w, h: draft.h,
        determinantId: det.id,
        category: det.category,
        label: det.text,
        grade: det.grade,
        tier: det.tier,
      };
      setBoxes((current) => [...current, box]);
      setSelectedId(box.id);
      setDraft(null);
      drawing.current = false;
      drawStart.current = null;
      setPendingDeterminant(null);
      return;
    }
    if (selectedId) {
      setBoxes((current) => current.map((box) => box.id === selectedId ? {
        ...box,
        determinantId: det.id,
        category: det.category,
        label: det.text,
        grade: det.grade,
        tier: det.tier,
      } : box));
      setPendingDeterminant(null);
      return;
    }
    setPendingDeterminant(det);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[data-box-id]')) return;
    const point = toPercent(event.clientX, event.clientY);
    drawStart.current = point;
    drawing.current = true;
    setDraft({ x: point.x, y: point.y, w: 0, h: 0 });
    setSelectedId('');
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drawing.current || !drawStart.current) return;
    const point = toPercent(event.clientX, event.clientY);
    setDraft({
      x: Math.min(drawStart.current.x, point.x),
      y: Math.min(drawStart.current.y, point.y),
      w: Math.abs(point.x - drawStart.current.x),
      h: Math.abs(point.y - drawStart.current.y),
    });
  };

  const handlePointerUp = () => {
    if (!drawing.current) return;
    drawing.current = false;
    if (!draft || draft.w < 2 || draft.h < 2) {
      setDraft(null);
      drawStart.current = null;
      return;
    }
    if (pendingDeterminant) applyDeterminant(pendingDeterminant);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#193b4d]/50 p-1.5 backdrop-blur-sm sm:p-2">
      <div className="modal-in flex h-[min(96dvh,880px)] w-full max-w-[min(98vw,1120px)] flex-col overflow-hidden rounded-2xl border border-white/80 bg-[#f9fcfd] shadow-[0_24px_70px_rgba(20,58,86,.28)]">
        <div className="flex shrink-0 items-center gap-2 border-b border-[#e3edf3] px-2.5 py-2 sm:px-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[11px] font-extrabold tracking-[-.02em] text-[#203c53] sm:text-[12px]">
              Annotate · {record.sampleType} · Grade {record.grade}
            </p>
            <p className="truncate text-[9px] text-[#7a95a8]">{GRADE_TIER_LABEL[record.grade]} · draw region, assign determinant</p>
          </div>
          <div className="flex shrink-0 gap-0.5 rounded-lg border border-[#dce9ef] bg-white/80 p-0.5">
            {(['A', 'B', 'C'] as Grade[]).map((grade) => (
              <button
                key={grade}
                type="button"
                onClick={() => setViewGrade(grade)}
                className={`focus-ring rounded-md px-2 py-0.5 text-[9px] font-extrabold transition ${viewGrade === grade ? 'blue-sheen text-white shadow-sm' : 'text-[#6e899b] hover:bg-[#f0f7fb]'}`}
              >
                {grade}
              </button>
            ))}
          </div>
          <button type="button" onClick={onClose} className="focus-ring flex size-7 shrink-0 items-center justify-center rounded-lg border border-[#d7e7ef] bg-white/80 text-[#628096] hover:text-[#167db0]"><X size={16} /></button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <div className="flex min-h-0 min-w-0 flex-[1.55] flex-col border-b border-[#e3edf3] p-2 lg:border-b-0 lg:border-r">
            <div
              ref={containerRef}
              className="relative min-h-[38vh] flex-1 cursor-crosshair overflow-hidden rounded-lg border border-[#d5e5ee] bg-[#e8f2f6] lg:min-h-0"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerLeave={handlePointerUp}
            >
              {url ? <img src={url} alt="Annotate sample" className="size-full object-contain" draggable={false} /> : imageError ? <div className="flex size-full items-center justify-center text-[#7a95a8]"><ImageIcon size={24} className="opacity-50" /></div> : <div className="flex size-full items-center justify-center"><Loader2 className="animate-spin text-[#3b9fca]" /></div>}
              {boxes.map((box) => (
                <div
                  key={box.id}
                  data-box-id={box.id}
                  className={`absolute border-2 ${selectedId === box.id ? 'border-[#2aa6d7] ring-2 ring-[#2aa6d7]/30' : 'border-amber-400'}`}
                  style={{ left: `${box.x}%`, top: `${box.y}%`, width: `${box.w}%`, height: `${box.h}%`, background: `${gradeColors[box.grade]}22` }}
                  onClick={(event) => { event.stopPropagation(); setSelectedId(box.id); }}
                >
                  <span className="absolute -top-5 left-0 max-w-[180px] truncate rounded px-1 py-0.5 text-[8px] font-bold text-white" style={{ background: gradeColors[box.grade] }}>
                    {box.category}
                  </span>
                </div>
              ))}
              {draft && draft.w > 0 && draft.h > 0 && (
                <div className="pointer-events-none absolute border-2 border-dashed border-[#2aa6d7] bg-[#2aa6d7]/10" style={{ left: `${draft.x}%`, top: `${draft.y}%`, width: `${draft.w}%`, height: `${draft.h}%` }} />
              )}
              <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-[#193b4d]/75 to-transparent px-2 py-1.5">
                <p className="text-[8px] font-medium text-white/95 sm:text-[9px]">
                  {pendingDeterminant ? `Selected: ${pendingDeterminant.category} — draw to apply` : 'Pick determinant → draw · or draw → pick determinant'}
                </p>
              </div>
            </div>
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col p-2">
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              {Object.entries(grouped).map(([category, items]) => (
                <div key={category} className="mb-3 last:mb-0">
                  <p className="sticky top-0 z-1 mb-1.5 bg-[#f9fcfd] py-1 text-[9px] font-extrabold uppercase tracking-[.08em] text-[#5c7587]">{category}</p>
                  <div className="space-y-1.5">
                    {items.map((det) => (
                      <button
                        key={det.id}
                        type="button"
                        onClick={() => applyDeterminant(det)}
                        className={`determinant-option-btn btn-card focus-ring w-full border transition ${pendingDeterminant?.id === det.id ? 'border-[#53b9df] bg-[#e9f8fc]' : 'border-[#d9e6ed] bg-white hover:border-[#b8d4e4] hover:bg-[#f4fafc]'}`}
                      >
                        <span className="determinant-option-tier text-[10px] font-extrabold text-[#47647a]">{det.tier}</span>
                        <span className="determinant-option-text line-clamp-3 text-[9px] text-[#7a95a8]">{det.text}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {boxes.length > 0 && (
              <div className="mt-2 max-h-24 shrink-0 overflow-y-auto border-t border-[#e3edf3] pt-2">
                <p className="mb-1 text-[8px] font-extrabold uppercase tracking-[.06em] text-[#94a3b8]">Regions ({boxes.length})</p>
                <div className="space-y-1">
                  {boxes.map((box) => (
                    <div key={box.id} className={`flex items-start gap-2 rounded-lg border px-2 py-1.5 text-[9px] ${selectedId === box.id ? 'border-[#53b9df] bg-[#e9f8fc]' : 'border-[#e3edf3] bg-white'}`}>
                      <span className="mt-1 size-1.5 shrink-0 rounded-full" style={{ background: gradeColors[box.grade] }} />
                      <button type="button" className="btn-card min-w-0 flex-1 border-0 bg-transparent p-0 text-left shadow-none hover:bg-transparent" onClick={() => setSelectedId(box.id)}>
                        <span className="block text-[9px] font-extrabold leading-tight text-[#47647a]">{box.category}</span>
                        <span className="mt-0.5 block line-clamp-2 text-[8px] leading-snug text-[#7a95a8]">{box.label}</span>
                      </button>
                      <button type="button" className="btn-card flex size-5 shrink-0 items-center justify-center text-[#888888] hover:bg-[#fff1f0] hover:text-[#c75a50]" onClick={() => setBoxes((current) => current.filter((item) => item.id !== box.id))}><X size={11} /></button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <details className="mt-1 shrink-0 rounded-md border border-[#e3edf3] bg-white/70 px-2 py-1 text-[9px] text-[#7a95a8]">
              <summary className="cursor-pointer font-extrabold text-[#5c7587]">Differential criteria</summary>
              <div className="mt-1 space-y-0.5">
                {differentials.map((item) => (
                  <p key={item.pair}><span className="font-extrabold text-[#47647a]">{item.pair}:</span> {item.note}</p>
                ))}
              </div>
            </details>
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[#e3edf3] px-2.5 py-2 sm:px-3">
          <button type="button" onClick={() => onSave(boxes)} className="focus-ring blue-sheen flex items-center gap-1.5 rounded-lg px-3 py-2 text-[10px] font-extrabold text-white shadow-sm sm:text-[11px]"><Check size={13} /> Save {boxes.length} determinant{boxes.length === 1 ? '' : 's'}</button>
          <button type="button" onClick={onClose} className="action-btn focus-ring px-3 py-2 text-[10px] sm:text-[11px]">Cancel</button>
        </div>
      </div>
    </div>
  );
}

function ShortcutModal({ onClose }: { onClose: () => void }) {
  const items = [
    ['Space', 'Capture a sample'],
    ['1 / 2 / 3 / 4', 'Assign Grade A / B / C / Invalid'],
    ['R', 'Open review gallery'],
    ['U', 'Undo last capture'],
    ['S', 'Open session tools'],
    ['E', 'Open end session panel'],
    ['Esc', 'Close the current modal'],
    ['?', 'Show shortcuts help'],
  ];
  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-[#18354a]/45 p-0 backdrop-blur-sm sm:items-center sm:p-4">
      <div className="modal-in flex max-h-dvh w-full flex-col overflow-hidden rounded-t-3xl border border-white/70 bg-[#f9fcfd] shadow-[0_25px_80px_rgba(20,58,86,.24)] sm:max-w-140 sm:rounded-[26px]">
        <div className="flex items-center justify-between border-b border-[#e1edf2] px-4 py-3 sm:px-5 sm:py-4">
          <div><p className="eyebrow">Keyboard shortcuts</p><h2 className="mt-1 text-[16px] font-extrabold text-[#203e54] sm:text-[18px]">Faster field workflow</h2></div>
          <button type="button" onClick={onClose} className="focus-ring rounded-lg p-2 text-[#78919f] hover:bg-white"><X size={18} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid gap-2 p-4 sm:p-5">
            {items.map(([key, description]) => (
              <div key={key} className="flex items-center justify-between rounded-[14px] border border-[#dde9f1] bg-white/80 px-3 py-2.5 sm:rounded-[18px] sm:px-4 sm:py-3">
                <span className="text-[10px] font-bold text-[#49677b] sm:text-[11px]">{description}</span>
                <span className="mono rounded-lg bg-[#eef4ff] px-2 py-1 text-[9px] font-bold text-[#4e63cf] sm:text-[10px]">{key}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="border-t border-[#e1edf2] bg-[#f0f6f9] px-4 py-2.5 text-[9px] text-[#7f95a5] sm:px-5 sm:py-3 sm:text-[10px]">Capture stays manual. Shortcuts only speed up actions you explicitly trigger.</div>
      </div>
    </div>
  );
}

function ToolRow({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return <div className="flex items-center gap-3 rounded-xl border border-[#deebf0] bg-white/70 p-2.5 sm:p-3"><div className="rounded-lg bg-[#eaf6fa] p-1.5 text-[#3b9dbc] sm:p-2">{icon}</div><div className="min-w-0"><p className="text-[10px] font-extrabold text-[#456276] sm:text-[11px]">{title}</p><p className="truncate text-[9px] text-[#849aa8] sm:text-[10px]">{detail}</p></div></div>;
}

export default App;
