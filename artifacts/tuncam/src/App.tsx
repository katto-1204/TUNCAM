import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  AlertTriangle, Aperture, Archive, BadgeCheck, Camera, Check, ChevronDown, ChevronLeft, CircleAlert,
  ClipboardList, CloudOff, Download, FileImage, FileUp, FolderOpen, Gauge, HardDrive,
  Image as ImageIcon, Info, Keyboard, LaptopMinimal, Loader2, MonitorDown, Pause, PenLine, Plus, RefreshCw, RotateCcw,
  ScanLine, Settings2, ShieldCheck, SlidersHorizontal, Trash2,
  Undo2, Upload, UserRound, Video, X, Zap, ArrowLeftRight,
} from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  buildFilename, datasetZipName, defaultSettings, exampleFilename, exportGuideText, gradeCode, gradeColors,
  gradeLabels, grades, jpegFilename, manifestCsv, manifestJson, photoZipPath, recordPath, sampleCode, siteCode, today,
  type Grade, type RecordItem, type SampleType, type SessionSettings, triggerDownload,
} from '@/lib/dataset';
import { deleteRelativeFile, ensureFolderPermission, FolderAccessError, pickSessionFolder, writeRelativeFile } from '@/lib/local-folder';
import { importSessionZip } from '@/lib/session-import';
import { clearSession, getAllImages, getImage, listRecords, loadDirectoryHandle, migrateLegacyRecords, putRecord, removeRecord, saveDirectoryHandle, updateRecord } from '@/lib/session-store';
import { buildZip, type ZipEntry } from '@/lib/zip';

const queryClient = new QueryClient();
const SETTINGS_KEY = 'tuncam-session-settings-v1';
const PREVIEW_STORAGE_KEY = 'tuncam-preview-urls-v1';
const CAMERA_TIMEOUT_MS = 12_000;

type CameraState = 'idle' | 'loading' | 'ready' | 'denied' | 'missing' | 'timeout';
type ToastItem = { id: number; message: string; tone?: 'info' | 'success' | 'warning' | 'error' };
type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

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
  const [storageStatus, setStorageStatus] = useState<{ used?: number; quota?: number; low: boolean }>({ low: false });
  const [folderChosen, setFolderChosen] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [gradeError, setGradeError] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
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

  const rememberPreview = useCallback((id: string, url: string) => {
    if (previewUrls.current[id]) URL.revokeObjectURL(previewUrls.current[id]);
    previewUrls.current[id] = url;
    setPreviews({ ...previewUrls.current });
    try {
      localStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(previewUrls.current));
    } catch {
      /* localStorage not available */
    }
  }, []);

  const forgetPreview = useCallback((id: string) => {
    if (previewUrls.current[id]) {
      URL.revokeObjectURL(previewUrls.current[id]);
      delete previewUrls.current[id];
      setPreviews({ ...previewUrls.current });
      try {
        localStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(previewUrls.current));
      } catch {
        /* localStorage not available */
      }
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
  const gradeCountsByType = useMemo(() => {
    const result: Record<string, Record<Grade, number>> = {};
    ['Sashibo Core', 'Tail-Cut'].forEach(type => {
      result[type] = grades.reduce((all, grade) => {
        all[grade] = records.filter((record) => record.sampleType === type && record.grade === grade).length;
        return all;
      }, {} as Record<Grade, number>);
    });
    return result;
  }, [records]);
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
        // Restore preview URLs from localStorage as backup
        try {
          const storedPreviewUrls = localStorage.getItem(PREVIEW_STORAGE_KEY);
          if (storedPreviewUrls) {
            const parsed = JSON.parse(storedPreviewUrls);
            // Revoke any existing object URLs that are being replaced
            Object.values(previewUrls.current).forEach((url) => URL.revokeObjectURL(url));
            previewUrls.current = parsed;
            setPreviews(parsed);
          }
        } catch {
          // localStorage might not be available in some contexts
        }
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
    let active = true;
    const inspectStorage = async () => {
      if (!navigator.storage?.estimate) return;
      const estimate = await navigator.storage.estimate();
      if (active) {
        const used = estimate.usage || 0;
        const quota = estimate.quota || 0;
        setStorageStatus({ used, quota, low: Boolean(quota && used / quota > .8) });
      }
    };
    inspectStorage();
    const timer = window.setInterval(inspectStorage, 15000);
    return () => { active = false; window.clearInterval(timer); };
  }, [records.length]);

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
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
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
  }, [isCapturing, isGradeOpen, missingFields, notify, readyToCapture]);

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
    if (!settings.sampleType && !settings.sampleTypeOverride) {
      setGradeError('No sample type selected. Go back and pick Sashibo Core or Tail-Cut.');
      return;
    }
    const effectiveSampleType = (settings.sampleTypeOverride || settings.sampleType) as SampleType;
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
      // Folder write failed but IDB save succeeded — warn but don't block
      notify('Image saved to browser but could not write to the chosen folder. Check folder permissions.', 'warning');
    }
    rememberPreview(record.id, capturedPreview || URL.createObjectURL(capturedBlob));
    setRecords((current) => [record, ...current]);
    setCapturedBlob(undefined);
    setCapturedPreview(undefined);
    setIsGradeOpen(false);
    setIsCapturing(false);
    setIsSavingGrade(false);
    setGradeError('');
    notify(`${jpegFilename(record)} saved.`, 'success');
  }, [capturedBlob, capturedPreview, currentSequence, isSavingGrade, rememberPreview, settings.sampleType, settings.site, writeToFolder, notify]);

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
        else if (isGradeOpen) discardCapture();
        else if (isReviewOpen) setIsReviewOpen(false);
        else if (isSettingsOpen) setIsSettingsOpen(false);
        else if (isEndOpen) setIsEndOpen(false);
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
      if (event.code === 'Space' && readyToCapture && !isEndOpen && !isReviewOpen && !isSettingsOpen) {
        event.preventDefault();
        captureFrame();
      }
    };
    window.addEventListener('keydown', handleKeys);
    return () => window.removeEventListener('keydown', handleKeys);
  }, [captureFrame, discardCapture, finalizeGrade, isEndOpen, isGradeOpen, isReviewOpen, isSettingsOpen, isShortcutOpen, readyToCapture, records.length]);

  const undoLast = async () => {
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
  };

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
      notify(`Saving into "${handle.name}" using tuncam / date-place / sample type / grade folders.`, 'success');
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
    <div className="noise app-shell">
      <div aria-hidden className="ambient-orb" style={{ width: 460, height: 460, top: -180, right: -140, background: 'radial-gradient(circle, rgba(124,150,255,.4), transparent 70%)' }} />
      <div aria-hidden className="ambient-orb" style={{ width: 400, height: 400, bottom: -160, left: -150, background: 'radial-gradient(circle, rgba(72,196,235,.32), transparent 70%)' }} />
      <main className="dashboard-frame">
        {/* ─── HEADER ─── */}
        <header className="glass-card flex min-h-14 items-center justify-between gap-3 rounded-[18px] px-3 py-2.5 sm:min-h-17 sm:rounded-[22px] sm:px-4 sm:py-3 md:px-6">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <div className="blue-sheen flex size-8 shrink-0 items-center justify-center rounded-[12px] text-white shadow-[0_8px_18px_rgba(22,132,221,.25)] sm:size-10 sm:rounded-[14px]"><Aperture size={18} strokeWidth={2.3} /></div>
            <div className="min-w-0">
              <div className="flex items-center gap-2"><h1 className="text-[15px] font-extrabold tracking-[-.04em] text-[#19344b] sm:text-[17px]">TUNCAM</h1><span className="hidden rounded-full bg-[#e6f6fb] px-2 py-0.5 text-[9px] font-bold uppercase tracking-[.12em] text-[#2185ae] sm:inline">Field instrument</span></div>
              <p className="truncate text-[9px] text-[#7891a4] sm:text-[10px]">Manual capture · local folders · offline</p>
            </div>
          </div>
          <div className="hidden items-center gap-5 lg:flex">
            <StatusChip icon={<CloudOff size={14} />} label="Offline ready" tone="cyan" />
            <StatusChip icon={<ShieldCheck size={14} />} label="Local only" tone="green" />
            <StatusChip icon={<Keyboard size={14} />} label="Shortcuts ready" tone="violet" />
            <span className="h-7 w-px bg-[#dbe8ef]" />
            <div className="text-right"><p className="eyebrow">Session date</p><p className="mono text-[12px] font-medium text-[#34536a]">{today()}</p></div>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2">
            {installPrompt && <button type="button" data-testid="button-install-app" onClick={installApp} className="focus-ring hidden items-center gap-2 rounded-xl border border-[#b9ddea] bg-white/80 px-3 py-2 text-[11px] font-bold text-[#1579a8] sm:flex"><Download size={14} />Install</button>}
            <button type="button" onClick={() => setIsShortcutOpen(true)} className="focus-ring hidden items-center gap-2 rounded-xl border border-[#dedcf7] bg-white/80 px-3 py-2 text-[11px] font-bold text-[#5d56b5] md:flex"><Keyboard size={14} /> Shortcuts</button>
            <button type="button" data-testid="button-open-settings" onClick={() => setIsSettingsOpen(true)} className="focus-ring flex size-8 items-center justify-center rounded-xl border border-[#d7e7ef] bg-white/80 text-[#628096] transition hover:bg-white hover:text-[#167db0] sm:size-9" aria-label="Open session tools"><Settings2 size={16} /></button>
            <div className="hidden size-9 items-center justify-center rounded-xl bg-[#e7f0f6] text-[11px] font-extrabold text-[#3b5c75] sm:flex">{settings.operator ? settings.operator.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase() : 'OP'}</div>
          </div>
        </header>

        {/* ─── SHORTCUT STRIP (hidden on mobile) ─── */}
        <section className="shortcut-strip mt-2 hidden flex-wrap items-center justify-between gap-2 rounded-[20px] px-4 py-3 sm:mt-3 md:flex">
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
        <section className="mt-2 grid gap-3 sm:mt-3 lg:grid-cols-[245px_minmax(380px,1fr)_285px] xl:grid-cols-[270px_minmax(420px,1fr)_322px]">
          {/* ── LEFT: Session Setup ── */}
          <aside className="soft-card rounded-[18px] p-3 sm:rounded-[22px] sm:p-4">
            <div className="mb-3 flex items-start justify-between sm:mb-4"><div><p className="eyebrow">01 / Session setup</p><h2 className="mt-1 text-[14px] font-extrabold tracking-[-.03em] text-[#203c53] sm:text-[16px]">Capture context</h2></div><div className="rounded-xl bg-[#eff8fc] p-2 text-[#2aa6d7]"><ClipboardList size={17} /></div></div>
            <div className="space-y-2.5 sm:space-y-3">
              <label><span className="field-label">Collection site <span className="text-[#d87871]">*</span></span><select data-testid="select-collection-site" value={settings.site} onChange={(event) => { if (event.target.value === '__new') { setSettings({ ...settings, site: '' }); setCustomSite(''); } else setSettings({ ...settings, site: event.target.value }); }} className="field-control"><option>General Santos City Fish Port Complex</option><option>Pag-Asa Bankerohan Fish Vendors Association, Inc. (Fish Bagsakan)</option>{customSite && <option value={customSite}>{customSite}</option>}<option value="__new">Add a new site…</option></select></label>
              {!settings.site && <div className="relative"><Plus className="field-icon" size={15} /><input data-testid="input-new-site" value={customSite} onChange={(event) => { setCustomSite(event.target.value); setSettings({ ...settings, site: event.target.value }); }} className="field-control with-icon" placeholder="e.g. Makar Wharf, Gensan" /></div>}
              <label><span className="field-label">Operator name <span className="text-[#d87871]">*</span></span><div className="relative"><UserRound className="field-icon" size={15} /><input data-testid="input-operator-name" value={settings.operator} onChange={(event) => setSettings({ ...settings, operator: event.target.value })} className="field-control with-icon" placeholder="Who is capturing?" autoComplete="name" /></div></label>
              <label><span className="field-label">Expert grader <span className="text-[#d87871]">*</span></span><div className="relative"><BadgeCheck className="field-icon" size={15} /><input data-testid="input-grader-name" value={settings.grader} onChange={(event) => setSettings({ ...settings, grader: event.target.value })} className="field-control with-icon" placeholder="Who is grading?" autoComplete="name" /></div></label>
              <label><span className="field-label">Storage location</span><button type="button" data-testid="button-choose-folder" onClick={() => void chooseFolder()} className="focus-ring flex h-10 w-full items-center gap-2 rounded-xl border border-[#d5e5ee] bg-[#f7fbfd] px-3 text-left text-[11px] text-[#557187] hover:border-[#7bc7e5]"><FolderOpen size={15} className="shrink-0 text-[#319ccc]" /><span className="min-w-0 flex-1 truncate">{folderChosen ? settings.storage : 'Choose any folder…'}</span><ChevronDown size={14} className="text-[#9ab1c0]" /></button></label>
              <div><span className="field-label">Sample type <span className="text-[#d87871]">*</span></span><div className="grid grid-cols-2 gap-2"><SampleOption value="Sashibo Core" selected={settings.sampleType === 'Sashibo Core'} onClick={() => setSettings({ ...settings, sampleType: 'Sashibo Core' })} code="SC" /><SampleOption value="Tail-Cut" selected={settings.sampleType === 'Tail-Cut'} onClick={() => setSettings({ ...settings, sampleType: 'Tail-Cut' })} code="TC" /></div></div>
              {settings.sampleType && (
                <div className="mt-2">
                  <span className="field-label">Type override</span>
                  <div className="grid grid-cols-2 gap-2">
                    <button type="button" onClick={() => setSettings({ ...settings, sampleTypeOverride: 'Sashibo Core' })} className={`focus-ring rounded-xl border p-2 text-left transition sm:p-2.5 ${settings.sampleTypeOverride === 'Sashibo Core' ? 'border-[#53b9df] bg-[#e9f8fc] shadow-[0_4px_12px_rgba(47,163,207,.1)]' : 'border-[#d9e6ed] bg-white/60 hover:bg-white'}`}><div className="flex items-center justify-between"><span className={`flex size-5 items-center justify-center rounded-lg text-[8px] font-extrabold sm:size-6 sm:text-[9px] ${settings.sampleTypeOverride === 'Sashibo Core' ? 'blue-sheen text-white' : 'bg-[#eaf2f6] text-[#658196]'}`}>SC</span>{settings.sampleTypeOverride === 'Sashibo Core' && <Check size={13} className="text-[#1a9bcb]" />}</div><p className="mt-1.5 text-[9px] font-extrabold text-[#47647a] sm:mt-2 sm:text-[10px]">Sashibo Core</p></button>
                    <button type="button" onClick={() => setSettings({ ...settings, sampleTypeOverride: 'Tail-Cut' })} className={`focus-ring rounded-xl border p-2 text-left transition sm:p-2.5 ${settings.sampleTypeOverride === 'Tail-Cut' ? 'border-[#53b9df] bg-[#e9f8fc] shadow-[0_4px_12px_rgba(47,163,207,.1)]' : 'border-[#d9e6ed] bg-white/60 hover:bg-white'}`}><div className="flex items-center justify-between"><span className={`flex size-5 items-center justify-center rounded-lg text-[8px] font-extrabold sm:size-6 sm:text-[9px] ${settings.sampleTypeOverride === 'Tail-Cut' ? 'blue-sheen text-white' : 'bg-[#eaf2f6] text-[#658196]'}`}>TC</span>{settings.sampleTypeOverride === 'Tail-Cut' && <Check size={13} className="text-[#1a9bcb]" />}</div><p className="mt-1.5 text-[9px] font-extrabold text-[#47647a] sm:mt-2 sm:text-[10px]">Tail-Cut</p></button>
                  </div>
                </div>
              )}
            </div>
            {/* Ready / Not-ready status */}
            <div className={`mt-3 rounded-[14px] border px-3 py-2 sm:mt-4 sm:rounded-[15px] sm:py-2.5 ${readyToCapture ? 'border-[#bde7da] bg-[#f0fbf7]' : 'border-[#e2edf2] bg-[#f8fbfc]'}`}>
              <div className="flex items-center gap-2">
                <span className={`size-2 rounded-full ${readyToCapture ? 'status-breathe bg-[#29b685]' : 'bg-[#c6d5de]'}`} />
                <span className="text-[10px] font-bold text-[#49677b] sm:text-[11px]">{readyToCapture ? 'Ready for manual capture' : 'Complete required fields'}</span>
              </div>
              <p className="mt-1 text-[9px] leading-4 text-[#8198a8] sm:text-[10px]">
                {readyToCapture
                  ? 'Press Capture or Spacebar when the sample is framed.'
                  : `Missing: ${missingFields.join(', ')}.`}
              </p>
            </div>
          </aside>

          {/* ── CENTER: Camera / Live view ── */}
          <section className="soft-card stage-card min-w-0 rounded-[18px] p-2.5 sm:rounded-[22px] sm:p-3 md:p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 sm:mb-3">
              <div>
                <p className="eyebrow">02 / Live view</p>
                <div className="mt-1 flex items-center gap-2">
                  <h2 className="text-[14px] font-extrabold tracking-[-.03em] text-[#203c53] sm:text-[16px]">Imaging chamber</h2>
                  <span className={`flex items-center gap-1.5 rounded-full px-2 py-1 text-[8px] font-extrabold uppercase tracking-[.08em] sm:text-[9px] ${cameraState === 'ready' ? 'bg-[#e5f8f2] text-[#238866]' : cameraState === 'idle' ? 'bg-[#edf1ff] text-[#3658c4]' : cameraState === 'loading' ? 'bg-[#fff8e8] text-[#bc8d49]' : 'bg-[#fff3e8] text-[#bc7449]'}`}>
                    {cameraState === 'ready' && <span className="live-dot size-1.5 rounded-full bg-[#29b685]" />}
                    {cameraState === 'ready' ? 'Live feed' : cameraState === 'loading' ? 'Connecting…' : cameraState === 'idle' ? 'Not connected' : cameraState === 'denied' ? 'Permission needed' : cameraState === 'timeout' ? 'Timed out' : 'No camera'}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1.5 sm:gap-2">
                <button type="button" data-testid="button-refresh-camera" onClick={() => { setSelectedDevice(''); void connectCamera(''); }} className="focus-ring flex size-8 items-center justify-center rounded-lg border border-[#dce9ef] bg-white/80 text-[#6e899b] hover:text-[#3658c4]" aria-label="Connect or refresh camera"><RefreshCw size={14} /></button>
                <select data-testid="select-camera-device" value={selectedDevice} onChange={(event) => { const deviceId = event.target.value; setSelectedDevice(deviceId); void connectCamera(deviceId); }} className="h-8 max-w-30 rounded-lg border border-[#dce9ef] bg-white/80 px-2 text-[10px] text-[#587185] sm:max-w-35" aria-label="Camera device"><option value="">Default camera</option>{devices.map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}</select>
              </div>
            </div>
            <div className={`relative aspect-16/10 min-h-50 overflow-hidden rounded-2xl bg-[#dce9ee] sm:min-h-72.5 sm:rounded-[22px] ${isCapturing ? 'capture-pulse' : ''}`}>
              {cameraState === 'ready' ? <video ref={videoRef} muted playsInline onLoadedMetadata={() => setVideoReady(true)} className="absolute inset-0 size-full object-cover" data-testid="video-camera-preview" /> : <CameraEmpty state={cameraState} issue={cameraIssue} onRetry={() => void connectCamera()} />}
              {cameraState === 'ready' && (
                <>
                  <div className="pointer-events-none absolute inset-[12%_10%] rounded-[14px] border-2 border-white/90 shadow-[0_0_0_999px_rgba(28,72,95,.16)] sm:inset-[17%_16%] sm:rounded-[18px]">
                    <span className="absolute -left-1 -top-1 size-4 border-l-2 border-t-2 border-[#62dded] sm:size-5" />
                    <span className="absolute -right-1 -top-1 size-4 border-r-2 border-t-2 border-[#62dded] sm:size-5" />
                    <span className="absolute -bottom-1 -left-1 size-4 border-b-2 border-l-2 border-[#62dded] sm:size-5" />
                    <span className="absolute -bottom-1 -right-1 size-4 border-b-2 border-r-2 border-[#62dded] sm:size-5" />
                  </div>
                  <div className="pointer-events-none absolute inset-x-[10%] top-1/2 h-px bg-white/35 sm:inset-x-[16%]" />
                  <div className="pointer-events-none absolute inset-y-[12%] left-1/2 w-px bg-white/35 sm:inset-y-[17%]" />
                  <div className="absolute left-2 top-2 flex items-center gap-2 rounded-full bg-[#193b4d]/60 px-2 py-1 text-[8px] font-bold text-white backdrop-blur sm:left-4 sm:top-4 sm:px-2.5 sm:py-1.5 sm:text-[9px]">ALIGN SAMPLE WITHIN GUIDE</div>
                  <div className="absolute right-2 top-2 flex items-center gap-1.5 rounded-full bg-[#193b4d]/60 px-2 py-1 text-[8px] font-extrabold uppercase tracking-[.14em] text-white backdrop-blur sm:right-4 sm:top-4 sm:px-2.5 sm:py-1.5 sm:text-[9px]"><span className="live-dot size-1.5 rounded-full bg-[#4ade80]" />Live</div>
                  <div className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-[#193b4d]/60 px-2.5 py-1 text-[9px] font-medium text-white/90 backdrop-blur sm:bottom-3 sm:px-3 sm:py-1.5 sm:text-[10px]">Manual shutter only · no auto-detect</div>
                </>
              )}
            </div>
            <canvas ref={canvasRef} className="hidden" />
            {/* Desktop capture controls (hidden on mobile — mobile uses sticky bottom bar) */}
            <div className="mt-2 hidden grid-cols-[1fr_auto_1fr] items-center gap-3 sm:mt-3 md:grid">
              <div className="flex items-center gap-2"><div className="rounded-lg bg-[#eaf5fa] p-2 text-[#3b9fca]"><ScanLine size={15} /></div><div><p className="text-[10px] font-bold text-[#4b687d]">Framing guide only</p><p className="text-[9px] text-[#8ca1af]">Capture happens when you press the button</p></div></div>
              <button type="button" data-testid="button-capture" disabled={!readyToCapture} onClick={captureFrame} className={`capture-button focus-ring group relative flex h-14 min-w-42.5 items-center justify-center gap-3 rounded-[18px] px-4 text-white transition hover:-translate-y-0.5 disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-45 lg:h-16 lg:min-w-47.5 lg:rounded-[20px] lg:px-5 ${readyToCapture ? 'blue-sheen' : 'bg-[#afc6d2]'}`}><span className="flex size-8 items-center justify-center rounded-xl border border-white/30 bg-white/15 lg:size-9"><Camera size={18} /></span><span className="text-left"><span className="block text-[11px] font-extrabold lg:text-[12px]">Capture sample</span><span className="mono block text-[8px] opacity-80 lg:text-[9px]">SPACEBAR</span></span></button>
              <div className="flex justify-end"><button type="button" data-testid="button-undo-last" disabled={!records.length} onClick={() => void undoLast()} className="action-btn focus-ring px-3 py-2.5 text-[10px]"><Undo2 size={14} /> Undo last</button></div>
            </div>
            {!readyToCapture && <p className="mt-2 text-center text-[9px] text-[#8aa0ae] sm:text-[10px]">Press Connect camera, fill the required fields, pick a sample type, then capture manually.</p>}
          </section>

          {/* ── RIGHT: Session pulse & actions ── */}
          <aside className="space-y-2 sm:space-y-3">
            {/* Tally */}
            <div className="soft-card rounded-[18px] p-3 sm:rounded-[22px] sm:p-4">
              <div className="flex items-start justify-between"><div><p className="eyebrow">03 / Session pulse</p><h2 className="mt-1 text-[14px] font-extrabold tracking-[-.03em] text-[#203c53] sm:text-[16px]">Today's tally</h2></div><div className="blue-sheen rounded-xl p-2 text-white"><Gauge size={17} /></div></div>
              <div className="mt-3 grid grid-cols-4 gap-1.5 sm:mt-4">{grades.map((grade) => <div key={grade} className="rounded-xl px-2 py-2 text-center transition-shadow sm:py-2.5" style={{ background: `${gradeColors[grade]}0f`, boxShadow: `inset 0 0 0 1px ${gradeColors[grade]}26` }}><div className="mx-auto mb-1 flex size-5 items-center justify-center rounded-lg text-[10px] font-extrabold text-white shadow-sm sm:size-6 sm:text-[11px]" style={{ background: gradeColors[grade] }}>{grade === 'Invalid' ? '!' : grade}</div><p data-testid={`text-count-${grade.toLowerCase()}`} className={`mono text-[16px] font-medium sm:text-[18px] ${counts[grade] ? '' : 'text-[#b7c7d2]'}`} style={counts[grade] ? { color: gradeColors[grade] } : undefined}>{counts[grade]}</p><p className="mt-0.5 text-[7px] font-bold uppercase tracking-[.06em] text-[#91a6b3] sm:text-[8px]">{grade === 'Invalid' ? 'bad' : 'grade'}</p></div>)}</div>
              <div className="mt-2 flex items-center justify-between border-t border-[#e6eef3] pt-2 sm:mt-3 sm:pt-3"><span className="text-[10px] font-bold text-[#577286] sm:text-[11px]">Total captured</span><span data-testid="text-total-captured" className="mono text-[16px] font-medium text-[#1c75ac] sm:text-[18px]">{records.length.toString().padStart(3, '0')}</span></div>
              {latestRecord && <div className="mt-2 rounded-2xl border border-[#d7e8f3] bg-white/70 p-2.5 sm:mt-3 sm:p-3"><p className="eyebrow">Last capture</p><p className="mt-1 truncate font-mono text-[10px] font-extrabold text-[#36576c] sm:text-[11px]">{jpegFilename(latestRecord)}</p><p className="mt-1 text-[9px] text-[#7f95a5] sm:text-[10px]">{latestRecord.sampleType} · {gradeLabels[latestRecord.grade]}</p></div>}
            </div>
            <div className="mt-3">
              {(['Sashibo Core', 'Tail-Cut'] as const).map((type) => {
                const typeInvalidCount = gradeCountsByType[type]?.Invalid ?? 0;
                const typeTotal = typeCounts[type];
                return (
                  <div key={type} className="soft-card rounded-[18px] p-3 sm:rounded-[22px] sm:p-4">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="eyebrow">Session pulse</p>
                        <h2 className="mt-1 text-[13px] font-extrabold tracking-[-.03em] text-[#203c53] sm:text-[15px]">Today's tally</h2>
                      </div>
                      <div className="text-right">
                        <span className="text-[9px] font-bold text-[#577286]">{typeInvalidCount} Invalid</span>
                        <span className="text-[8px] text-[#7f95a5]">of {typeTotal}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Progress */}
            <div className="soft-card rounded-[18px] p-3 sm:rounded-[22px] sm:p-4"><div className="flex items-center justify-between"><div><p className="eyebrow">Progress / target 800</p><p className="mt-1 text-[11px] font-bold text-[#426278] sm:text-[12px]">Class balance</p></div><SlidersHorizontal size={16} className="text-[#78a1b7]" /></div><div className="mt-2 space-y-2 sm:mt-3 sm:space-y-3">{(['Sashibo Core', 'Tail-Cut'] as SampleType[]).map((type) => <div key={type}><div className="mb-1 flex items-center justify-between text-[9px] sm:mb-1.5 sm:text-[10px]"><span className="font-bold text-[#5c7587]">{type}</span><span className="mono text-[#849aa8]">{typeCounts[type]} / 3,200</span></div><div className="h-1.5 overflow-hidden rounded-full bg-[#e5eff4] sm:h-2"><div className="h-full rounded-full bg-linear-to-r from-[#39b9e7] to-[#4a78df] transition-all duration-500" style={{ width: `${Math.min(100, typeCounts[type] / 32)}%` }} /></div></div>)}</div></div>

            {/* Storage */}
            <div className="soft-card rounded-[18px] p-3 sm:rounded-[22px] sm:p-4"><div className="flex items-center justify-between"><div className="flex items-center gap-2"><HardDrive size={16} className={storageStatus.low ? 'text-[#d8796e]' : 'text-[#3c9cbb]'} /><span className="text-[10px] font-extrabold text-[#466479] sm:text-[11px]">Local storage</span></div><span className={`rounded-full px-2 py-1 text-[8px] font-bold sm:text-[9px] ${storageStatus.low ? 'bg-[#fff0ed] text-[#bd685f]' : 'bg-[#ebf8f4] text-[#2e8c70]'}`}>{storageStatus.low ? 'Review soon' : 'Healthy'}</span></div><p className="mt-1.5 text-[9px] leading-4 text-[#8499a8] sm:mt-2 sm:text-[10px]">{storageStatus.quota ? `${formatBytes(storageStatus.used || 0)} used of ${formatBytes(storageStatus.quota)} browser quota.` : 'Browser storage estimate will appear when supported.'}</p>{storageStatus.quota ? <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#e5eff4]" data-testid="bar-storage-usage"><div className="h-full rounded-full transition-all duration-700" style={{ width: `${Math.min(100, ((storageStatus.used || 0) / storageStatus.quota) * 100)}%`, background: storageStatus.low ? 'linear-gradient(90deg,#f0a28e,#d8776f)' : 'linear-gradient(90deg,#39b9e7,#4a78df)' }} /></div> : null}{storageStatus.low && <div className="mt-2 flex gap-2 rounded-lg bg-[#fff5f1] p-2 text-[9px] text-[#ae6259] sm:text-[10px]"><CircleAlert size={14} className="shrink-0" /> Download the photos ZIP and copy it to a backup drive.</div>}</div>

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
        <footer className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1 pb-2 text-[9px] text-[#7d95a5] sm:mt-3 sm:gap-3 sm:text-[10px]"><div className="flex items-center gap-2 sm:gap-3"><span className="flex items-center gap-1.5"><Zap size={12} className="text-[#28a5d0]" /> Manual capture-to-grade loop</span><span className="hidden h-3 w-px bg-[#cbdde6] sm:inline" /><span className="hidden items-center gap-1.5 sm:flex"><ShieldCheck size={12} className="text-[#49a88a]" /> No cloud sync</span></div><div className="flex items-center gap-2 sm:gap-3"><button type="button" data-testid="button-toggle-awake" onClick={() => void toggleAwake()} className={`focus-ring flex items-center gap-1.5 rounded-lg px-2 py-1 text-[9px] font-bold sm:text-[10px] ${isAwake ? 'bg-[#e5f8f2] text-[#25886e]' : 'hover:bg-white/70'}`}>{isAwake ? <Pause size={11} /> : <MonitorDown size={11} />}{isAwake ? 'Awake on' : 'Prevent sleep'}</button>{wakeSupport === 'unsupported' && <span className="text-[#b47a63]">Browser support unavailable</span>}<span className="mono">TUNCAM v1.0</span></div></footer>
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
          className={`capture-button focus-ring flex h-12 min-w-35 items-center justify-center gap-2 rounded-2xl px-4 text-white transition disabled:cursor-not-allowed disabled:opacity-45 ${readyToCapture ? 'blue-sheen' : 'bg-[#afc6d2]'}`}
        >
          <Camera size={18} />
          <span className="text-[12px] font-extrabold">Capture</span>
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
      {isGradeOpen && <GradeModal image={capturedPreview} error={gradeError} onSelect={(grade) => void finalizeGrade(grade)} onCancel={discardCapture} />}
      {isReviewOpen && <ReviewModal records={records} previews={previews} exporting={isExporting} overriding={isOverriding} onClose={() => setIsReviewOpen(false)} onDelete={(id) => void deleteRecord(id)} onOverrideGrade={(id, grade) => void overrideGrade(id, grade)} onAnnotationUpdate={(id, annotations) => void updateAnnotation(id, annotations)} onTypeOverride={(id, sampleType) => void overrideSampleType(id, sampleType)} onExport={exportManifest} onDownload={() => void exportDataset()} />}
      {isEndOpen && <EndModal records={records} settings={settings} exporting={isExporting} onClose={() => setIsEndOpen(false)} onConfirmEnd={handleConfirmEndSession} onExport={exportManifest} onDownload={handleEndSession} />}
      {isSettingsOpen && <ToolsModal settings={settings} onClose={() => setIsSettingsOpen(false)} onInstall={installPrompt ? installApp : undefined} />}
      {isShortcutOpen && <ShortcutModal onClose={() => setIsShortcutOpen(false)} />}

      {/* ─── TOASTS ─── */}
      <div className="fixed bottom-16 left-1/2 z-50 flex w-[min(92vw,390px)] -translate-x-1/2 flex-col gap-2 md:bottom-4">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast-in flex items-center gap-2 rounded-xl border px-3 py-2 text-[10px] font-bold shadow-[0_12px_30px_rgba(38,80,112,.16)] sm:py-2.5 sm:text-[11px] ${toast.tone === 'success' ? 'border-[#b9e8d7] bg-[#f0fbf7] text-[#267f69]' : toast.tone === 'warning' ? 'border-[#f0d4c2] bg-[#fff7f1] text-[#a66b54]' : toast.tone === 'error' ? 'border-[#f0b8b4] bg-[#fff1f0] text-[#a64843]' : 'border-[#c8e4ee] bg-white text-[#4c6c80]'}`}>
            {toast.tone === 'error' ? <AlertTriangle size={14} /> : <Info size={14} />} {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   Sub-components
   ═══════════════════════════════════════════════════════════════════════════ */

function RecordThumbnail({ record, previewUrl }: { record: RecordItem; previewUrl?: string }) {
  const [url, setUrl] = useState<string | undefined>(previewUrl);
  const [error, setError] = useState(false);

  useEffect(() => {
    setUrl(previewUrl);
    setError(false);
  }, [previewUrl]);

  useEffect(() => {
    if (!url && !error) {
      let active = true;
      getImage(record.id).then((blob) => {
        if (active) {
          if (blob && blob.size > 0) {
            setUrl(URL.createObjectURL(blob));
          } else {
            setError(true);
          }
        }
      }).catch(() => {
        if (active) setError(true);
      });
      return () => { active = false; };
    }
    return undefined;
  }, [record.id, url, error]);

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
      onError={() => setError(true)}
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
      className={`soft-card export-card rounded-[18px] p-3 sm:rounded-[22px] sm:p-4 ${dragOver ? 'import-dropzone-active' : 'import-dropzone'}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="eyebrow">04 / Wrap-up</p>
          <h2 className="mt-1 text-[14px] font-extrabold tracking-[-.03em] text-[#203c53] sm:text-[16px]">Export &amp; merge</h2>
        </div>
        <div className={`rounded-xl p-2 transition ${dragOver ? 'blue-sheen text-white' : 'bg-[#eaf6fb] text-[#2aa6d7]'}`}><FileImage size={17} /></div>
      </div>
      {count > 0 && <FilenamePreview name={exampleName} />}
      <button
        type="button"
        data-testid="button-download-dataset"
        disabled={!count || exporting}
        onClick={onDownload}
        className="focus-ring mt-2.5 flex w-full items-center justify-center gap-2 rounded-xl bg-[#214e69] py-2.5 text-[9px] font-extrabold text-white hover:bg-[#1b4259] disabled:opacity-40 sm:mt-3 sm:py-3 sm:text-[10px]"
      >
        <Download size={14} />{exporting ? 'Packing photos…' : `Download ${count || 0} photo${count === 1 ? '' : 's'} ZIP`}
      </button>

      <div className="mt-2 grid grid-cols-3 gap-1.5 sm:gap-2">
        <button type="button" data-testid="button-open-review" onClick={onReview} className="action-btn focus-ring text-[9px] sm:text-[10px]">
          <ImageIcon size={13} /> Review
          <span className="rounded-full bg-[#eaf4f8] px-1.5 py-0.5 mono text-[8px] font-bold text-[#4182a1]">{count}</span>
        </button>
        <button type="button" data-testid="button-import-data" disabled={importing} onClick={onImportClick} className="action-btn action-btn-accent focus-ring text-[9px] sm:text-[10px]" title={importing ? 'Reading session ZIP…' : 'Merge a TUNCAM ZIP exported on another laptop'}>
          {importing ? <Loader2 size={13} className="animate-spin" /> : <FileUp size={13} />}
          {importing ? 'Merging…' : 'Import'}
        </button>
        <button type="button" data-testid="button-end-session" onClick={onEnd} className="action-btn action-btn-violet focus-ring text-[9px] sm:text-[10px]">
          <Archive size={13} /> End
        </button>
      </div>

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
function SampleOption({ value, selected, onClick, code }: { value: SampleType; selected: boolean; onClick: () => void; code: string }) {
  return <button type="button" data-testid={`button-sample-${code.toLowerCase()}`} onClick={onClick} className={`focus-ring rounded-xl border p-2 text-left transition sm:p-2.5 ${selected ? 'border-[#53b9df] bg-[#e9f8fc] shadow-[0_4px_12px_rgba(47,163,207,.1)]' : 'border-[#d9e6ed] bg-white/60 hover:bg-white'}`}><div className="flex items-center justify-between"><span className={`flex size-5 items-center justify-center rounded-lg text-[8px] font-extrabold sm:size-6 sm:text-[9px] ${selected ? 'blue-sheen text-white' : 'bg-[#eaf2f6] text-[#658196]'}`}>{code}</span>{selected && <Check size={13} className="text-[#1a9bcb]" />}</div><p className="mt-1.5 text-[9px] font-extrabold text-[#47647a] sm:mt-2 sm:text-[10px]">{value}</p></button>;
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
            className="focus-ring mt-3 rounded-lg bg-linear-to-r from-[#5278ec] to-[#274bc2] px-4 py-2 text-[10px] font-extrabold text-white shadow-[0_8px_18px_rgba(45,76,196,.2)] sm:py-2.5"
          >
            {state === 'idle' ? 'Connect camera' : 'Try camera again'}
          </button>
        )}
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

  const [annotationId, setAnnotationOpen] = useState('');
  const annotationRecord = annotationId ? records.find((record) => record.id === annotationId) : undefined;

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
                      <RecordThumbnail record={selectedRecord} previewUrl={previews[selectedRecord.id]} />
                    </div>
                  </div>
                  <div className="mt-3 rounded-2xl border border-[#ececec] bg-white p-3 sm:mt-4 sm:rounded-[18px] sm:p-4">
                    <p className="eyebrow text-[#94a3b8]">Filename</p>
                    <p className="mt-1.5 break-all font-mono text-[11px] font-bold leading-5 text-[#1e293b] sm:mt-2 sm:text-[12px] md:text-[13px]">{jpegFilename(selectedRecord)}</p>
                    <p className="mt-1.5 text-[9px] leading-5 text-[#94a3b8] sm:mt-2 sm:text-[10px]">
                      Saved under tuncam / date-place / sample type / grade as date-site-sampletypecode-grade-sequence.jpg.
                    </p>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="overflow-hidden rounded-2xl border border-[#e3edf3] bg-linear-to-b from-white to-[#f7fbfd] shadow-[0_8px_22px_rgba(38,83,109,.05)] sm:rounded-[18px]">
                    <div className="flex items-center justify-between gap-2 border-b border-[#edf4f8] bg-white/70 px-3 py-2.5 sm:px-4">
                      <p className="eyebrow text-[#288bab]">Manual grade override</p>
                      {selectedRecord.originalGrade && selectedRecord.originalGrade !== selectedRecord.grade ? (
                        <span data-testid="badge-overridden" className="flex shrink-0 items-center gap-1 rounded-full bg-[#fff7ec] px-2 py-0.5 text-[7px] font-extrabold uppercase tracking-[.08em] text-[#b98a49] sm:text-[8px]"><PenLine size={10} /> Overridden</span>
                      ) : (
                        <span className="shrink-0 rounded-full bg-[#f1f5f9] px-2 py-0.5 text-[7px] font-extrabold uppercase tracking-[.08em] text-[#94a3b8] sm:text-[8px]">As captured</span>
                      )}
                    </div>
                    <div className="p-3 sm:p-4">
                      {/* Current grade */}
                      <div className="flex items-center justify-between rounded-xl border border-[#e6eff4] bg-white px-3 py-2">
        <span className="text-[8px] font-bold uppercase tracking-[.08em] text-[#94a3b8] sm:text-[9px]">Current grade</span>
        <span className="flex items-center gap-1.5 text-[10px] font-extrabold text-[#334155] sm:text-[11px]">
          <span className="size-2.5 rounded-full" style={{ background: gradeColors[selectedRecord.grade] }} />
          {gradeLabels[selectedRecord.grade]}
        </span>
      </div>

                      {/* Grade buttons */}
                      <div className="mt-2 grid grid-cols-4 gap-1.5 sm:mt-2.5 sm:gap-2" onMouseLeave={() => setPendingGrade('')}>
                        {grades.map((grade, index) => {
                          const active = selectedRecord.grade === grade;
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
                              className={`focus-ring group relative flex min-h-14 flex-col items-center justify-center gap-1 rounded-[12px] border py-2 text-center transition disabled:cursor-default ${active ? 'border-transparent text-white shadow-[0_6px_14px_rgba(38,83,109,.16)]' : 'border-[#d8e6ed] bg-white hover:-translate-y-0.5 hover:border-[#7dc8e1] hover:shadow-[0_8px_18px_rgba(38,83,109,.09)] disabled:hover:translate-y-0 disabled:hover:shadow-none disabled:opacity-50'}`}
                            style={active ? { background: gradeColors[grade] } : undefined}
                            >
                              {active && <Check size={12} className="absolute right-1.5 top-1.5" />}
                              <span className={`mono absolute left-1.5 top-1 text-[8px] font-medium ${active ? 'text-white/60' : 'text-[#c3d2db]'}`}>{index + 1}</span>
                              {!active && <span className="size-2 rounded-full" style={{ background: gradeColors[grade] }} />}
                              <span className={`text-[11px] font-extrabold ${active ? '' : 'text-[#3d5a6e]'}`}>{grade === 'Invalid' ? 'Inv' : grade}</span>
                              <span className={`text-[6px] font-bold uppercase tracking-[.06em] ${active ? 'text-white/70' : 'text-[#9fb3bf]'}`}>{active ? 'current' : 'override'}</span>
                            </button>
                          );
                        })}
                      </div>

                      {/* Live rename preview */}
                      <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-[#eef4f8] bg-white px-2 py-1.5" data-testid="preview-rename">
                        {pendingGrade ? (
                          <>
                            <FileImage size={12} className="mt-0.5 shrink-0 text-[#2aa4ce]" />
                            <p className="min-w-0 break-all font-mono text-[8px] leading-4 text-[#36576c] sm:text-[9px]">
                              Renames to <span className="font-bold">{buildFilename(selectedRecord.site, selectedRecord.sampleType, pendingGrade, selectedRecord.sequence, selectedRecord.date)}</span>
                            </p>
                          </>
                        ) : (
                          <>
                            <Info size={12} className="mt-0.5 shrink-0 text-[#a5bac6]" />
                            <p className="text-[8px] leading-4 text-[#9fb3bf] sm:text-[9px]">Hover a grade to preview the new filename — the tally and folders update too.</p>
                          </>
                        )}
                      </div>

                      {/* Revert / audit line */}
                      {selectedRecord.originalGrade && selectedRecord.originalGrade !== selectedRecord.grade && (
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[#f8fafc] px-2.5 py-2">
                          <p className="text-[8px] font-bold text-[#94a3b8] sm:text-[9px]">
                            Originally {gradeLabels[selectedRecord.originalGrade]} · overridden {selectedRecord.overriddenAt ? new Date(selectedRecord.overriddenAt).toLocaleString() : ''}
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

                  <div className="rounded-2xl border border-[#ececec] bg-white p-3 sm:rounded-[18px] sm:p-4">
                    <p className="eyebrow text-[#94a3b8]">Capture info</p>
                    <div className="mt-2 grid gap-2 sm:mt-3">
                      {[
                        { label: 'Sample type', value: selectedRecord.sampleType },
                        { label: 'Current grade', value: gradeLabels[selectedRecord.grade] },
                        { label: 'Collection site', value: selectedRecord.site },
                        { label: 'Capture date', value: selectedRecord.date },
                        { label: 'Sequence', value: String(selectedRecord.sequence).padStart(3, '0') },
                        { label: 'Created at', value: new Date(selectedRecord.createdAt).toLocaleString() },
                      ].map((item) => (
                        <div key={item.label} className="rounded-xl border border-[#f1f5f9] bg-[#fafafa] px-3 py-2">
                          <p className="text-[8px] font-bold uppercase tracking-[.08em] text-[#94a3b8] sm:text-[9px]">{item.label}</p>
                          <p className="mt-0.5 text-[10px] font-extrabold text-[#334155] sm:mt-1 sm:text-[11px]">{item.value}</p>
                        </div>
                      ))}
{selectedRecord.annotations && selectedRecord.annotations.length > 0 && (
                        <div key="annotations" className="rounded-xl border border-[#e6f7ff] bg-[#f0f7ff] px-3 py-2">
                          <p className="text-[8px] font-bold uppercase tracking-[.06em] text-[#2185ae] mb-1">Annotations</p>
                          <div className="space-y-1 max-h-40 overflow-y-auto">
                            {selectedRecord.annotations.map((annotation, idx) => (
                              <div key={idx} className="flex items-center gap-2 px-2 py-1 rounded bg-white text-[9px] text-[#47647a]">
                                <span className="flex-1 break-all">{annotation}</span>
                                <button
                                  type="button"
                                  onClick={() => onAnnotationUpdate!(selectedRecord.id, selectedRecord.annotations!.filter((_, i) => i !== idx))}
                                  className="text-[#888888] hover:text-[#c75a50]"><X size={12} /></button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      <div className="mt-2">
                        {selectedRecord.sampleType && (
                          <button
                            type="button"
                            onClick={() => onTypeOverride(selectedRecord.id, selectedRecord.sampleType === 'Sashibo Core' ? 'Tail-Cut' : 'Sashibo Core')}
                            className="focus-ring rounded-lg border border-[#d4e6ed] bg-white/80 px-3 py-1.5 text-[9px] font-bold text-[#527084] hover:bg-[#eef4ff] sm:py-2 sm:text-[10px]"
                          >
                            <ArrowLeftRight size={13} /> Override type to {selectedRecord.sampleType === 'Sashibo Core' ? 'Tail-Cut' : 'Sashibo Core'}
                          </button>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => setAnnotationOpen(selectedRecord.id)}
                        className="mt-2 rounded-lg border border-[#d4e6ed] bg-white/80 px-3 py-1.5 text-[9px] font-bold text-[#527084] hover:bg-[#eef4ff] sm:py-2 sm:text-[10px]"
                      >
                        <PenLine size={13} /> Add annotation
                      </button>
                    </div>
                  </div>

                  <button
                    type="button"
                    data-testid={`button-delete-record-${selectedRecord.id}`}
                    onClick={() => handleDelete(selectedRecord.id)}
                    className="focus-ring flex w-full items-center justify-center gap-2 rounded-[14px] border border-[#f0d4c2] bg-[#fff7f1] px-4 py-2.5 text-[10px] font-extrabold text-[#b0634f] hover:bg-[#fff2ea] sm:rounded-2xl sm:py-3 sm:text-[11px]"
                  >
                    <Trash2 size={15} /> Delete this capture
                  </button>
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
                            className="review-gallery-card focus-ring group text-left"
                          >
                            <div className="relative aspect-square overflow-hidden rounded-[12px] bg-[#f1f5f9] sm:rounded-[14px]">
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
            <button type="button" data-testid="button-download-dataset-review" disabled={!records.length || exporting} onClick={onDownload} className="focus-ring flex items-center gap-1.5 rounded-lg bg-[#214e69] px-2.5 py-1.5 text-[9px] font-extrabold text-white disabled:opacity-40 sm:px-3 sm:py-2 sm:text-[10px]">
              <FileImage size={12} /> Download ZIP
            </button>
            <button type="button" data-testid="button-done-review" onClick={onClose} className="focus-ring rounded-lg border border-[#d1e1e8] bg-white px-3 py-1.5 text-[9px] font-extrabold text-[#214e69] sm:px-4 sm:py-2 sm:text-[10px]">
              Done
            </button>
          </div>
        </div>
      </div>
      {annotationRecord && (
        <AnnotationModal
          recordId={annotationRecord.id}
          annotations={annotationRecord.annotations ?? []}
          onSave={(list) => { onAnnotationUpdate(annotationRecord.id, list); setAnnotationOpen(''); }}
          onClose={() => setAnnotationOpen('')}
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
          <button type="button" data-testid="button-download-dataset-end" disabled={!records.length || exporting} onClick={onDownload} className="focus-ring flex w-full items-center justify-center gap-2 rounded-xl bg-[#214e69] py-2.5 text-[10px] font-extrabold text-white disabled:opacity-40 sm:py-3 sm:text-[11px]">
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

function AnnotationModal({ recordId, annotations, onSave, onClose }: { recordId: string; annotations: string[]; onSave: (annotations: string[]) => void; onClose: () => void }) {
  const [text, setText] = useState<string>('');
  useEffect(() => {
    setText(annotations.join(', ') || '');
  }, [annotations]);
  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-[#18354a]/50 p-0 backdrop-blur-md sm:items-center sm:p-4">
      <div className="modal-in flex max-h-[80dvh] w-full flex-col overflow-hidden rounded-t-3xl border border-white/80 bg-[#f9fcfd] shadow-[0_30px_90px_rgba(20,58,86,.32)] sm:max-w-160 sm:rounded-3xl">
        <div className="relative flex items-start justify-between border-b border-[#e4edf2] bg-linear-to-r from-white/90 to-[#f2f9fc] px-4 py-3 sm:px-5 sm:py-4 md:px-6">
          <div>
            <p className="eyebrow text-[#288bab]">Add annotation</p>
            <h2 className="mt-1 text-[17px] font-extrabold tracking-[-.04em] text-[#1f3c52] sm:text-[20px]">Annotate this capture</h2>
            <p className="mt-1 text-[10px] text-[#77909e] sm:text-[11px]">Add free-text notes about this sample.</p>
          </div>
        </div>

        <div className="p-4 sm:p-5">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            className="w-full border border-[#d1e1e8] rounded-md px-3 py-2 text-[12px] font-medium text-[#1e293b] sm:text-[13px] focus-ring focus:border-[#3b82f6] focus:outline-none resize-none sm:resize-y"
            placeholder="Enter annotation notes..."
          /></div>

        <div className="flex items-center justify-between border-t border-[#e4edf2] bg-linear-to-r from-[#f0f6f9] to-[#f7fafc] px-4 py-3 text-[9px] text-[#78909e] sm:px-5 sm:py-3 sm:text-[10px] md:px-6">
          <button
            type="button"
            onClick={() => onSave(text.split(',').map((t) => t.trim()).filter((t) => t.length > 0))}
            className="focus-ring flex items-center gap-2 rounded-xl bg-[#214e69] py-2.5 text-[9px] font-extrabold text-white disabled:opacity-40 sm:py-3 sm:text-[10px]"
          >
            <Check size={14} /> Save
          </button>
          <button
            type="button"
            onClick={onClose}
            className="focus-ring rounded-lg border border-[#d1e1e8] bg-white py-2.5 text-[9px] font-bold text-[#527084] sm:py-3 sm:text-[10px]"
          >
            Cancel
          </button>
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

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export default App;
