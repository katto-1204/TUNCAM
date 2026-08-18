import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Aperture, Archive, BadgeCheck, Camera, Check, ChevronDown, ChevronLeft, CircleAlert,
  ClipboardList, CloudOff, Download, FileImage, FolderOpen, Gauge, HardDrive,
  Image as ImageIcon, Info, Keyboard, MonitorDown, Pause, Plus, RefreshCw,
  ScanLine, Settings2, ShieldCheck, SlidersHorizontal, Trash2,
  Undo2, Upload, UserRound, Video, X, Zap,
} from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  buildFilename, datasetZipName, defaultSettings, exampleFilename, exportGuideText, gradeColors,
  gradeLabels, grades, jpegFilename, manifestCsv, manifestJson, photoZipPath, recordPath, today,
  type Grade, type RecordItem, type SampleType, type SessionSettings, triggerDownload,
} from '@/lib/dataset';
import { deleteRelativeFile, ensureFolderPermission, pickSessionFolder, writeRelativeFile } from '@/lib/local-folder';
import { getAllImages, listRecords, loadDirectoryHandle, migrateLegacyRecords, putRecord, removeRecord, saveDirectoryHandle } from '@/lib/session-store';
import { buildZip, type ZipEntry } from '@/lib/zip';

const queryClient = new QueryClient();
const SETTINGS_KEY = 'tuncam-session-settings-v1';

type CameraState = 'idle' | 'loading' | 'ready' | 'denied' | 'missing';
type ToastItem = { id: number; message: string; tone?: 'info' | 'success' | 'warning' };
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
  const [isAwake, setIsAwake] = useState(false);
  const [wakeSupport, setWakeSupport] = useState<'unknown' | 'supported' | 'unsupported'>('unknown');
  const [storageStatus, setStorageStatus] = useState<{ used?: number; quota?: number; low: boolean }>({ low: false });
  const [folderChosen, setFolderChosen] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  const folderRef = useRef<FileSystemDirectoryHandle | null>(null);
  const toastId = useRef(1);
  const previewUrls = useRef<Record<string, string>>({});

  const notify = useCallback((message: string, tone: ToastItem['tone'] = 'info') => {
    const id = toastId.current++;
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 3600);
  }, []);

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

  const connectCamera = useCallback(async (deviceId = selectedDevice) => {
    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
      setCameraState('missing');
      setCameraIssue('Camera access requires HTTPS or localhost. Open the published PWA, then press Connect camera.');
      return;
    }

    setCameraState('loading');
    setCameraIssue('');
    setVideoReady(false);

    try {
      const videoConstraints: MediaTrackConstraints = {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        facingMode: deviceId ? undefined : { ideal: 'environment' },
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      };
      const nextStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
      setStream((old) => {
        old?.getTracks().forEach((track) => track.stop());
        return nextStream;
      });
      setCameraState('ready');
      const listed = await navigator.mediaDevices.enumerateDevices();
      setDevices(listed.filter((device) => device.kind === 'videoinput'));
      notify('Camera connected. Frame the sample, then press Capture.', 'success');
    } catch (error) {
      const errorName = error instanceof DOMException ? error.name : '';
      setCameraState('denied');
      setCameraIssue(
        errorName === 'NotAllowedError'
          ? 'Camera access is blocked. Use the browser lock icon to allow camera access, then press Connect camera.'
          : 'Camera could not be opened. Check that the webcam is connected and not in use by another app.',
      );
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
  const latestRecord = records[0];
  const readyToCapture = Boolean(settings.site && settings.operator.trim() && settings.grader.trim() && settings.sampleType && cameraState === 'ready' && videoReady);
  const currentSequence = records.length ? Math.max(...records.map((record) => record.sequence)) + 1 : 1;

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
  }, [stream]);

  const discardCapture = useCallback(() => {
    if (capturedPreview) URL.revokeObjectURL(capturedPreview);
    setCapturedBlob(undefined);
    setCapturedPreview(undefined);
    setIsGradeOpen(false);
    setIsCapturing(false);
  }, [capturedPreview]);

  const captureFrame = useCallback(() => {
    if (!readyToCapture || !videoRef.current || !canvasRef.current || isGradeOpen || isCapturing) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      notify('Camera is still warming up. Try again in a moment.', 'warning');
      return;
    }
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) return;
    setIsCapturing(true);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) {
        setIsCapturing(false);
        notify('Capture failed. Try again.', 'warning');
        return;
      }
      setCapturedBlob(blob);
      setCapturedPreview(URL.createObjectURL(blob));
      setIsGradeOpen(true);
    }, 'image/jpeg', 0.92);
  }, [isCapturing, isGradeOpen, notify, readyToCapture]);

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

  const finalizeGrade = useCallback(async (grade: Grade) => {
    if (!settings.sampleType || !capturedBlob) return;
    const date = today();
    const sequence = currentSequence;
    const record: RecordItem = {
      id: `${Date.now()}-${sequence}`,
      filename: buildFilename(settings.site, settings.sampleType, grade, sequence, date),
      date,
      site: settings.site,
      sampleType: settings.sampleType,
      grade,
      sequence,
      createdAt: new Date().toISOString(),
    };
    try {
      await putRecord(record, capturedBlob);
      await writeToFolder(record, capturedBlob);
      rememberPreview(record.id, capturedPreview || URL.createObjectURL(capturedBlob));
      setRecords((current) => [record, ...current]);
      setCapturedBlob(undefined);
      setCapturedPreview(undefined);
      setIsGradeOpen(false);
      setIsCapturing(false);
      notify(`${jpegFilename(record)} saved.`, 'success');
    } catch {
      notify('Could not save this capture. Check storage space and try again.', 'warning');
    }
  }, [capturedBlob, capturedPreview, currentSequence, rememberPreview, settings.sampleType, settings.site, writeToFolder, notify]);

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

  const chooseFolder = async () => {
    try {
      const handle = await pickSessionFolder();
      if (!handle) {
        notify('Folder access is not available in this browser. Download the ZIP at the end of the session.', 'warning');
        return;
      }
      const allowed = await ensureFolderPermission(handle);
      if (!allowed) {
        notify('Folder permission was not granted.', 'warning');
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
      notify(`Saving into “${handle.name}” using tuncam / date-place / sample type / grade folders.`, 'success');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        notify('Folder selection cancelled. Nothing changed.', 'info');
        return;
      }
      notify('Could not open that folder.', 'warning');
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

  return (
    <div className="noise app-shell">
      <main className="dashboard-frame">
        <header className="glass-card flex min-h-[68px] items-center justify-between gap-4 rounded-[22px] px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="blue-sheen flex size-10 shrink-0 items-center justify-center rounded-[14px] text-white shadow-[0_8px_18px_rgba(22,132,221,.25)]"><Aperture size={21} strokeWidth={2.3} /></div>
            <div className="min-w-0">
              <div className="flex items-center gap-2"><h1 className="text-[17px] font-extrabold tracking-[-.04em] text-[#19344b]">TUNCAM</h1><span className="hidden rounded-full bg-[#e6f6fb] px-2 py-0.5 text-[9px] font-bold uppercase tracking-[.12em] text-[#2185ae] sm:inline">Field instrument</span></div>
              <p className="truncate text-[10px] text-[#7891a4]">Manual capture · local folders · offline</p>
            </div>
          </div>
          <div className="hidden items-center gap-5 lg:flex">
            <StatusChip icon={<CloudOff size={14} />} label="Offline ready" tone="cyan" />
            <StatusChip icon={<ShieldCheck size={14} />} label="Local only" tone="green" />
            <StatusChip icon={<Keyboard size={14} />} label="Shortcuts ready" tone="violet" />
            <span className="h-7 w-px bg-[#dbe8ef]" />
            <div className="text-right"><p className="eyebrow">Session date</p><p className="mono text-[12px] font-medium text-[#34536a]">{today()}</p></div>
          </div>
          <div className="flex items-center gap-2">
            {installPrompt && <button type="button" data-testid="button-install-app" onClick={installApp} className="focus-ring hidden items-center gap-2 rounded-xl border border-[#b9ddea] bg-white/80 px-3 py-2 text-[11px] font-bold text-[#1579a8] sm:flex"><Download size={14} /> Install</button>}
            <button type="button" onClick={() => setIsShortcutOpen(true)} className="focus-ring hidden items-center gap-2 rounded-xl border border-[#dedcf7] bg-white/80 px-3 py-2 text-[11px] font-bold text-[#5d56b5] md:flex"><Keyboard size={14} /> Shortcuts</button>
            <button type="button" data-testid="button-open-settings" onClick={() => setIsSettingsOpen(true)} className="focus-ring flex size-9 items-center justify-center rounded-xl border border-[#d7e7ef] bg-white/80 text-[#628096] transition hover:bg-white hover:text-[#167db0]" aria-label="Open session tools"><Settings2 size={17} /></button>
            <div className="hidden size-9 items-center justify-center rounded-xl bg-[#e7f0f6] text-[11px] font-extrabold text-[#3b5c75] sm:flex">{settings.operator ? settings.operator.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase() : 'OP'}</div>
          </div>
        </header>
        <section className="shortcut-strip mt-3 flex flex-wrap items-center justify-between gap-2 rounded-[20px] px-4 py-3">
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

        <section className="mt-3 grid gap-3 xl:grid-cols-[270px_minmax(420px,1fr)_322px] lg:grid-cols-[245px_minmax(380px,1fr)_285px]">
          <aside className="soft-card rounded-[22px] p-4">
            <div className="mb-4 flex items-start justify-between"><div><p className="eyebrow">01 / Session setup</p><h2 className="mt-1 text-[16px] font-extrabold tracking-[-.03em] text-[#203c53]">Capture context</h2></div><div className="rounded-xl bg-[#eff8fc] p-2 text-[#2aa6d7]"><ClipboardList size={17} /></div></div>
            <div className="space-y-3">
              <label><span className="field-label">Collection site <span className="text-[#d87871]">*</span></span><select data-testid="select-collection-site" value={settings.site} onChange={(event) => { if (event.target.value === '__new') { setSettings({ ...settings, site: '' }); setCustomSite(''); } else setSettings({ ...settings, site: event.target.value }); }} className="field-control"><option>Bangkerohan, General Santos City</option><option>Fish Port, General Santos City</option><option>Navotas Fish Port, Metro Manila</option>{customSite && <option value={customSite}>{customSite}</option>}<option value="__new">Add a new site…</option></select></label>
              {!settings.site && <div className="relative"><Plus className="field-icon" size={15} /><input data-testid="input-new-site" value={customSite} onChange={(event) => { setCustomSite(event.target.value); setSettings({ ...settings, site: event.target.value }); }} className="field-control with-icon" placeholder="e.g. Makar Wharf, Gensan" /></div>}
              <label><span className="field-label">Operator name <span className="text-[#d87871]">*</span></span><div className="relative"><UserRound className="field-icon" size={15} /><input data-testid="input-operator-name" value={settings.operator} onChange={(event) => setSettings({ ...settings, operator: event.target.value })} className="field-control with-icon" placeholder="Who is capturing?" autoComplete="name" /></div></label>
              <label><span className="field-label">Expert grader <span className="text-[#d87871]">*</span></span><div className="relative"><BadgeCheck className="field-icon" size={15} /><input data-testid="input-grader-name" value={settings.grader} onChange={(event) => setSettings({ ...settings, grader: event.target.value })} className="field-control with-icon" placeholder="Who is grading?" autoComplete="name" /></div></label>
              <label><span className="field-label">Storage location</span><button type="button" data-testid="button-choose-folder" onClick={() => void chooseFolder()} className="focus-ring flex h-10 w-full items-center gap-2 rounded-xl border border-[#d5e5ee] bg-[#f7fbfd] px-3 text-left text-[11px] text-[#557187] hover:border-[#7bc7e5]"><FolderOpen size={15} className="shrink-0 text-[#319ccc]" /><span className="min-w-0 flex-1 truncate">{folderChosen ? settings.storage : 'Choose a local folder (optional)'}</span><ChevronDown size={14} className="text-[#9ab1c0]" /></button></label>
              <div><span className="field-label">Sample type <span className="text-[#d87871]">*</span></span><div className="grid grid-cols-2 gap-2"><SampleOption value="Sashibo Core" selected={settings.sampleType === 'Sashibo Core'} onClick={() => setSettings({ ...settings, sampleType: 'Sashibo Core' })} code="SC" /><SampleOption value="Tail-Cut" selected={settings.sampleType === 'Tail-Cut'} onClick={() => setSettings({ ...settings, sampleType: 'Tail-Cut' })} code="TC" /></div></div>
            </div>
            <div className={`mt-4 rounded-[15px] border px-3 py-2.5 ${readyToCapture ? 'border-[#bde7da] bg-[#f0fbf7]' : 'border-[#e2edf2] bg-[#f8fbfc]'}`}><div className="flex items-center gap-2"><span className={`size-2 rounded-full ${readyToCapture ? 'status-breathe bg-[#29b685]' : 'bg-[#c6d5de]'}`} /><span className="text-[11px] font-bold text-[#49677b]">{readyToCapture ? 'Ready for manual capture' : 'Complete required fields'}</span></div><p className="mt-1 text-[10px] leading-4 text-[#8198a8]">{readyToCapture ? 'Nothing auto-captures. Press Capture or Spacebar when the sample is framed.' : 'Site, operator, grader, sample type and a connected camera are required.'}</p></div>
          </aside>

          <section className="soft-card stage-card min-w-0 rounded-[22px] p-3 sm:p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><p className="eyebrow">02 / Live view</p><div className="mt-1 flex items-center gap-2"><h2 className="text-[16px] font-extrabold tracking-[-.03em] text-[#203c53]">Imaging chamber</h2><span className={`rounded-full px-2 py-1 text-[9px] font-extrabold uppercase tracking-[.08em] ${cameraState === 'ready' ? 'bg-[#e5f8f2] text-[#238866]' : cameraState === 'idle' ? 'bg-[#edf1ff] text-[#3658c4]' : 'bg-[#fff3e8] text-[#bc7449]'}`}>{cameraState === 'ready' ? 'Live feed' : cameraState === 'loading' ? 'Connecting' : cameraState === 'idle' ? 'Not connected' : cameraState === 'denied' ? 'Permission needed' : 'No camera'}</span></div></div><div className="flex items-center gap-2"><button type="button" data-testid="button-refresh-camera" onClick={() => { setSelectedDevice(''); void connectCamera(''); }} className="focus-ring flex size-8 items-center justify-center rounded-lg border border-[#dce9ef] bg-white/80 text-[#6e899b] hover:text-[#3658c4]" aria-label="Connect or refresh camera"><RefreshCw size={14} /></button><select data-testid="select-camera-device" value={selectedDevice} onChange={(event) => { const deviceId = event.target.value; setSelectedDevice(deviceId); void connectCamera(deviceId); }} className="h-8 max-w-[140px] rounded-lg border border-[#dce9ef] bg-white/80 px-2 text-[10px] text-[#587185]" aria-label="Camera device"><option value="">Default camera</option>{devices.map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}</select></div></div>
            <div className={`relative aspect-[16/10] min-h-[290px] overflow-hidden rounded-[22px] bg-[#dce9ee] ${isCapturing ? 'capture-pulse' : ''}`}>
              {cameraState === 'ready' ? <video ref={videoRef} muted playsInline onLoadedMetadata={() => setVideoReady(true)} className="absolute inset-0 size-full object-cover" data-testid="video-camera-preview" /> : <CameraEmpty state={cameraState} issue={cameraIssue} onRetry={() => void connectCamera()} />}
              {cameraState === 'ready' && (
                <>
                  <div className="pointer-events-none absolute inset-[17%_16%] rounded-[18px] border-2 border-white/90 shadow-[0_0_0_999px_rgba(28,72,95,.16)]">
                    <span className="absolute -left-1 -top-1 size-5 border-l-2 border-t-2 border-[#62dded]" />
                    <span className="absolute -right-1 -top-1 size-5 border-r-2 border-t-2 border-[#62dded]" />
                    <span className="absolute -bottom-1 -left-1 size-5 border-b-2 border-l-2 border-[#62dded]" />
                    <span className="absolute -bottom-1 -right-1 size-5 border-b-2 border-r-2 border-[#62dded]" />
                  </div>
                  <div className="pointer-events-none absolute inset-x-[16%] top-1/2 h-px bg-white/35" />
                  <div className="pointer-events-none absolute inset-y-[17%] left-1/2 w-px bg-white/35" />
                  <div className="absolute left-4 top-4 flex items-center gap-2 rounded-full bg-[#193b4d]/60 px-2.5 py-1.5 text-[9px] font-bold text-white backdrop-blur">ALIGN SAMPLE WITHIN GUIDE</div>
                  <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-[#193b4d]/60 px-3 py-1.5 text-[10px] font-medium text-white/90 backdrop-blur">Manual shutter only · no auto-detect</div>
                </>
              )}
            </div>
            <canvas ref={canvasRef} className="hidden" />
            <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-3">
              <div className="hidden items-center gap-2 sm:flex"><div className="rounded-lg bg-[#eaf5fa] p-2 text-[#3b9fca]"><ScanLine size={15} /></div><div><p className="text-[10px] font-bold text-[#4b687d]">Framing guide only</p><p className="text-[9px] text-[#8ca1af]">Capture happens when you press the button</p></div></div>
              <button type="button" data-testid="button-capture" disabled={!readyToCapture} onClick={captureFrame} className={`capture-button focus-ring group relative flex h-[64px] min-w-[190px] items-center justify-center gap-3 rounded-[20px] px-5 text-white transition hover:-translate-y-0.5 disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-45 ${readyToCapture ? 'blue-sheen' : 'bg-[#afc6d2]'}`}><span className="flex size-9 items-center justify-center rounded-xl border border-white/30 bg-white/15"><Camera size={19} /></span><span className="text-left"><span className="block text-[12px] font-extrabold">Capture sample</span><span className="mono block text-[9px] opacity-80">SPACEBAR</span></span></button>
              <div className="flex justify-end"><button type="button" data-testid="button-undo-last" disabled={!records.length} onClick={() => void undoLast()} className="focus-ring flex items-center gap-2 rounded-xl border border-[#d8e7ee] bg-white/70 px-3 py-2.5 text-[10px] font-bold text-[#617b8d] hover:bg-white disabled:opacity-40"><Undo2 size={14} /> <span className="hidden sm:inline">Undo last</span></button></div>
            </div>
            {!readyToCapture && <p className="mt-2 text-center text-[10px] text-[#8aa0ae]">Press Connect camera, fill the required fields, pick a sample type, then capture manually.</p>}
          </section>

          <aside className="space-y-3">
            <div className="soft-card rounded-[22px] p-4"><div className="flex items-start justify-between"><div><p className="eyebrow">03 / Session pulse</p><h2 className="mt-1 text-[16px] font-extrabold tracking-[-.03em] text-[#203c53]">Today’s tally</h2></div><div className="blue-sheen rounded-xl p-2 text-white"><Gauge size={17} /></div></div><div className="mt-4 grid grid-cols-4 gap-1.5">{grades.map((grade) => <div key={grade} className="rounded-xl bg-[#f5f9fb] px-2 py-2.5 text-center"><div className="mx-auto mb-1 flex size-6 items-center justify-center rounded-lg text-[11px] font-extrabold text-white" style={{ background: gradeColors[grade] }}>{grade === 'Invalid' ? '!' : grade}</div><p data-testid={`text-count-${grade.toLowerCase()}`} className="mono text-[18px] font-medium text-[#24435a]">{counts[grade]}</p><p className="mt-0.5 text-[8px] font-bold uppercase tracking-[.06em] text-[#91a6b3]">{grade === 'Invalid' ? 'bad' : 'grade'}</p></div>)}</div><div className="mt-3 flex items-center justify-between border-t border-[#e6eef3] pt-3"><span className="text-[11px] font-bold text-[#577286]">Total captured</span><span data-testid="text-total-captured" className="mono text-[18px] font-medium text-[#1c75ac]">{records.length.toString().padStart(3, '0')}</span></div>{latestRecord && <div className="mt-3 rounded-2xl border border-[#d7e8f3] bg-white/70 p-3"><p className="eyebrow">Last capture</p><p className="mt-1 truncate font-mono text-[11px] font-extrabold text-[#36576c]">{jpegFilename(latestRecord)}</p><p className="mt-1 text-[10px] text-[#7f95a5]">{latestRecord.sampleType} · {gradeLabels[latestRecord.grade]}</p></div>}</div>
            <div className="soft-card rounded-[22px] p-4"><div className="flex items-center justify-between"><div><p className="eyebrow">Progress / target 800</p><p className="mt-1 text-[12px] font-bold text-[#426278]">Class balance</p></div><SlidersHorizontal size={16} className="text-[#78a1b7]" /></div><div className="mt-3 space-y-3">{(['Sashibo Core', 'Tail-Cut'] as SampleType[]).map((type) => <div key={type}><div className="mb-1.5 flex items-center justify-between text-[10px]"><span className="font-bold text-[#5c7587]">{type}</span><span className="mono text-[#849aa8]">{typeCounts[type]} / 3,200</span></div><div className="h-2 overflow-hidden rounded-full bg-[#e5eff4]"><div className="h-full rounded-full bg-gradient-to-r from-[#39b9e7] to-[#4a78df] transition-all duration-500" style={{ width: `${Math.min(100, typeCounts[type] / 32)}%` }} /></div></div>)}</div></div>
            <div className="soft-card rounded-[22px] p-4"><div className="flex items-center justify-between"><div className="flex items-center gap-2"><HardDrive size={16} className={storageStatus.low ? 'text-[#d8796e]' : 'text-[#3c9cbb]'} /><span className="text-[11px] font-extrabold text-[#466479]">Local storage</span></div><span className={`rounded-full px-2 py-1 text-[9px] font-bold ${storageStatus.low ? 'bg-[#fff0ed] text-[#bd685f]' : 'bg-[#ebf8f4] text-[#2e8c70]'}`}>{storageStatus.low ? 'Review soon' : 'Healthy'}</span></div><p className="mt-2 text-[10px] leading-4 text-[#8499a8]">{storageStatus.quota ? `${formatBytes(storageStatus.used || 0)} used of ${formatBytes(storageStatus.quota)} browser quota.` : 'Browser storage estimate will appear when supported.'}</p>{storageStatus.low && <div className="mt-2 flex gap-2 rounded-lg bg-[#fff5f1] p-2 text-[10px] text-[#ae6259]"><CircleAlert size={14} className="shrink-0" /> Download the photos ZIP and copy it to a backup drive.</div>}</div>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" data-testid="button-open-review" onClick={() => setIsReviewOpen(true)} className="focus-ring flex items-center justify-center gap-2 rounded-xl border border-[#d5e5ed] bg-white/80 py-3 text-[10px] font-extrabold text-[#4c6b7f] hover:bg-white"><ImageIcon size={15} /> Review <span className="rounded-full bg-[#eaf4f8] px-1.5 py-0.5 text-[9px] text-[#4182a1]">{records.length}</span></button>
              <button type="button" data-testid="button-end-session" onClick={() => setIsEndOpen(true)} className="focus-ring flex items-center justify-center gap-2 rounded-xl border border-[#e2dfe8] bg-white/80 py-3 text-[10px] font-extrabold text-[#766587] hover:bg-white"><Archive size={15} /> End session</button>
            </div>
            <DownloadPanel
              exampleName={exampleFilename(settings.site)}
              count={records.length}
              exporting={isExporting}
              onDownload={() => void exportDataset()}
            />
          </aside>
        </section>

        <footer className="mt-3 flex flex-wrap items-center justify-between gap-3 px-1 pb-2 text-[10px] text-[#7d95a5]"><div className="flex items-center gap-3"><span className="flex items-center gap-1.5"><Zap size={13} className="text-[#28a5d0]" /> Manual capture-to-grade loop</span><span className="hidden h-3 w-px bg-[#cbdde6] sm:inline" /><span className="hidden items-center gap-1.5 sm:flex"><ShieldCheck size={13} className="text-[#49a88a]" /> No cloud sync</span></div><div className="flex items-center gap-3"><button type="button" data-testid="button-toggle-awake" onClick={() => void toggleAwake()} className={`focus-ring flex items-center gap-1.5 rounded-lg px-2 py-1 font-bold ${isAwake ? 'bg-[#e5f8f2] text-[#25886e]' : 'hover:bg-white/70'}`}>{isAwake ? <Pause size={12} /> : <MonitorDown size={12} />}{isAwake ? 'Awake on' : 'Prevent sleep'}</button>{wakeSupport === 'unsupported' && <span className="text-[#b47a63]">Browser support unavailable</span>}<span className="mono">TUNCAM v1.0</span></div></footer>
      </main>
      {isGradeOpen && <GradeModal image={capturedPreview} onSelect={(grade) => void finalizeGrade(grade)} onCancel={discardCapture} />}
      {isReviewOpen && <ReviewModal records={records} previews={previews} exporting={isExporting} onClose={() => setIsReviewOpen(false)} onDelete={(id) => void deleteRecord(id)} onExport={exportManifest} onDownload={() => void exportDataset()} />}
      {isEndOpen && <EndModal records={records} settings={settings} exporting={isExporting} onClose={() => setIsEndOpen(false)} onExport={exportManifest} onDownload={() => void exportDataset()} />}
      {isSettingsOpen && <ToolsModal settings={settings} onClose={() => setIsSettingsOpen(false)} onInstall={installPrompt ? installApp : undefined} />}
      {isShortcutOpen && <ShortcutModal onClose={() => setIsShortcutOpen(false)} />}
      <div className="fixed bottom-4 left-1/2 z-50 flex w-[min(92vw,390px)] -translate-x-1/2 flex-col gap-2">{toasts.map((toast) => <div key={toast.id} className={`toast-in flex items-center gap-2 rounded-xl border px-3 py-2.5 text-[11px] font-bold shadow-[0_12px_30px_rgba(38,80,112,.16)] ${toast.tone === 'success' ? 'border-[#b9e8d7] bg-[#f0fbf7] text-[#267f69]' : toast.tone === 'warning' ? 'border-[#f0d4c2] bg-[#fff7f1] text-[#a66b54]' : 'border-[#c8e4ee] bg-white text-[#4c6c80]'}`}><Info size={14} /> {toast.message}</div>)}</div>
    </div>
  );
}

function DownloadPanel({ exampleName, count, exporting, onDownload }: { exampleName: string; count: number; exporting: boolean; onDownload: () => void }) {
  return (
    <div className="export-card soft-card rounded-[22px] p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="eyebrow">04 / Download</p>
          <h2 className="mt-1 text-[16px] font-extrabold tracking-[-.03em] text-[#203c53]">Photos ZIP</h2>
        </div>
        <div className="rounded-xl bg-[#eaf6fb] p-2 text-[#2aa6d7]"><FileImage size={17} /></div>
      </div>
      <p className="mt-2 text-[10px] leading-4 text-[#7d94a4]">Extract the ZIP into tuncam / date-place / Tail-Cut or Sashibo-Core / GradeA–Invalid. Example file:</p>
      <FilenamePreview name={exampleName} />
      <button
        type="button"
        data-testid="button-download-dataset"
        disabled={!count || exporting}
        onClick={onDownload}
        className="focus-ring mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-[#214e69] py-3 text-[10px] font-extrabold text-white hover:bg-[#1b4259] disabled:opacity-40"
      >
        <Download size={15} />{exporting ? 'Packing photos…' : `Download ${count || 0} photo${count === 1 ? '' : 's'} ZIP`}
      </button>
    </div>
  );
}

function FilenamePreview({ name }: { name: string }) {
  const parts = name.replace(/\.jpg$/i, '').split('-');
  const date = parts.slice(0, 3).join('-');
  const sequence = parts.at(-1) || '001';
  const grade = parts.at(-2) || 'A';
  const code = parts.at(-3) || 'sc';
  const site = parts.slice(3, -3).join('-') || 'bangkerohan';
  return (
    <div className="filename-chip mt-3 rounded-[16px] border border-[#d4e6f0] bg-white/85 p-3">
      <p className="break-all font-mono text-[11px] font-bold leading-5 text-[#214e69]">{name}</p>
      <div className="mt-2 flex flex-wrap gap-1">
        {[
          ['date', date],
          ['site', site],
          ['type', code],
          ['grade', grade],
          ['seq', sequence],
        ].map(([label, value]) => (
          <span key={label} className="rounded-full bg-[#eef6fb] px-2 py-0.5 text-[8px] font-bold uppercase tracking-[.06em] text-[#5b7a8e]">
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
  return <button type="button" data-testid={`button-sample-${code.toLowerCase()}`} onClick={onClick} className={`focus-ring rounded-xl border p-2.5 text-left transition ${selected ? 'border-[#53b9df] bg-[#e9f8fc] shadow-[0_4px_12px_rgba(47,163,207,.1)]' : 'border-[#d9e6ed] bg-white/60 hover:bg-white'}`}><div className="flex items-center justify-between"><span className={`flex size-6 items-center justify-center rounded-lg text-[9px] font-extrabold ${selected ? 'blue-sheen text-white' : 'bg-[#eaf2f6] text-[#658196]'}`}>{code}</span>{selected && <Check size={14} className="text-[#1a9bcb]" />}</div><p className="mt-2 text-[10px] font-extrabold text-[#47647a]">{value}</p></button>;
}
function CameraEmpty({ state, issue, onRetry }: { state: CameraState; issue?: string; onRetry: () => void }) {
  const text = state === 'loading' ? 'Connecting to camera…' : state === 'idle' ? 'Camera is not connected' : state === 'denied' ? 'Camera permission needed' : 'No camera detected';
  const detail = issue || (state === 'denied' ? 'Allow camera access in your browser, then try again.' : state === 'missing' ? 'This browser does not expose a camera API. Use a supported webcam on HTTPS or localhost.' : 'Press Connect camera, allow access, frame the sample, then capture manually. Nothing is auto-detected.');
  return <div className="absolute inset-0 flex items-center justify-center bg-[radial-gradient(circle_at_50%_36%,#eef2ff,#dce4f7)]"><div className="max-w-[290px] px-4 text-center"><div className="mx-auto mb-3 flex size-14 items-center justify-center rounded-2xl border border-white/80 bg-white/70 text-[#3f5fd0] shadow-sm">{state === 'loading' ? <RefreshCw className="animate-spin" size={25} /> : <Video size={25} />}</div><p className="text-[13px] font-extrabold text-[#3f507a]">{text}</p><p className="mt-1 text-[10px] leading-4 text-[#7180a3]">{detail}</p>{state !== 'loading' && state !== 'missing' && <button type="button" data-testid="button-camera-retry" onClick={onRetry} className="focus-ring mt-3 rounded-lg bg-gradient-to-r from-[#5278ec] to-[#274bc2] px-4 py-2.5 text-[10px] font-extrabold text-white shadow-[0_8px_18px_rgba(45,76,196,.2)]">{state === 'idle' ? 'Connect camera' : 'Try camera again'}</button>}</div></div>;
}
function GradeModal({ image, onSelect, onCancel }: { image?: string; onSelect: (grade: Grade) => void; onCancel: () => void }) {
  return <div className="fixed inset-0 z-40 flex items-center justify-center bg-[#18354a]/45 p-4 backdrop-blur-sm"><div className="modal-in w-full max-w-[620px] overflow-hidden rounded-[24px] border border-white/70 bg-[#f9fcfd] shadow-[0_25px_80px_rgba(20,58,86,.28)]"><div className="flex items-start justify-between border-b border-[#e4edf2] px-5 py-4 sm:px-6"><div><p className="eyebrow text-[#288bab]">Capture held · label required</p><h2 className="mt-1 text-[20px] font-extrabold tracking-[-.04em] text-[#1f3c52]">How would you grade this sample?</h2><p className="mt-1 text-[11px] text-[#77909e]">Choose one label to save the image and continue.</p></div><div className="rounded-xl bg-[#eaf7fb] p-2 text-[#299ac4]"><ClipboardList size={18} /></div></div><div className="grid gap-4 p-5 sm:grid-cols-[160px_1fr] sm:p-6">{image ? <img src={image} alt="Captured tuna sample awaiting grade" className="aspect-square w-full rounded-[15px] border border-[#dbe8ee] object-cover" /> : <div className="flex aspect-square items-center justify-center rounded-[15px] bg-[#eaf1f5] text-[#7a98aa]"><ImageIcon /></div>}<div className="grid grid-cols-2 gap-2.5">{grades.map((grade, index) => <button type="button" key={grade} data-testid={`button-grade-${grade.toLowerCase()}`} onClick={() => onSelect(grade)} className="focus-ring group flex min-h-[86px] flex-col items-start justify-between rounded-[15px] border border-[#d8e6ed] bg-white p-3 text-left shadow-[0_4px_12px_rgba(38,83,109,.04)] transition hover:-translate-y-0.5 hover:border-[#7dc8e1] hover:shadow-[0_9px_20px_rgba(38,83,109,.11)]"><div className="flex w-full items-center justify-between"><span className="flex size-8 items-center justify-center rounded-xl text-[13px] font-extrabold text-white" style={{ background: gradeColors[grade] }}>{grade === 'Invalid' ? '!' : grade}</span><span className="mono text-[10px] text-[#a0b1bb]">{index + 1}</span></div><span className="text-[11px] font-extrabold text-[#486579]">{gradeLabels[grade]}</span></button>)}</div></div><div className="flex items-center justify-between bg-[#f0f6f9] px-5 py-3 text-[10px] text-[#78909e] sm:px-6"><span className="flex items-center gap-2"><Zap size={13} className="text-[#2aa4ce]" /> Keyboard ready: 1 / 2 / 3 / 4</span><button type="button" data-testid="button-cancel-capture" onClick={onCancel} className="focus-ring font-bold text-[#6d8493] hover:text-[#287a9f]">Discard frame</button></div></div></div>;
}
function ReviewModal({ records, previews, exporting, onClose, onDelete, onExport, onDownload }: { records: RecordItem[]; previews: Record<string, string>; exporting: boolean; onClose: () => void; onDelete: (id: string) => void; onExport: (format: 'csv' | 'json') => void; onDownload: () => void }) {
  const [selectedId, setSelectedId] = useState('');
  const [gradeFilter, setGradeFilter] = useState<Grade | 'All'>('All');

  const gradeCounts = useMemo(() => {
    const counts: Record<Grade | 'All', number> = { All: records.length, A: 0, B: 0, C: 0, Invalid: 0 };
    for (const record of records) counts[record.grade] += 1;
    return counts;
  }, [records]);

  const filteredRecords = useMemo(() => {
    if (gradeFilter === 'All') return records;
    return records.filter((record) => record.grade === gradeFilter);
  }, [records, gradeFilter]);

  useEffect(() => {
    if (selectedId && !records.some((record) => record.id === selectedId)) {
      setSelectedId('');
    }
  }, [records, selectedId]);

  const selectedRecord = selectedId ? records.find((record) => record.id === selectedId) : undefined;
  const inDetail = Boolean(selectedRecord);

  const handleDelete = (id: string) => {
    onDelete(id);
    if (selectedId === id) setSelectedId('');
  };

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-3 backdrop-blur-[2px] sm:p-4">
      <div className="review-modal modal-in flex max-h-[min(900px,94dvh)] w-full max-w-[1180px] flex-col overflow-hidden rounded-[24px] border border-[#ebebeb] bg-white shadow-[0_24px_80px_rgba(15,23,42,.14)]">
        <div className="flex shrink-0 items-center justify-between border-b border-[#f0f0f0] bg-white px-4 py-4 sm:px-6">
          <div className="min-w-0">
            {inDetail ? (
              <button
                type="button"
                data-testid="button-back-review"
                onClick={() => setSelectedId('')}
                className="focus-ring mb-2 flex items-center gap-1.5 rounded-lg px-1 py-0.5 text-[11px] font-bold text-[#64748b] transition hover:bg-[#f8fafc] hover:text-[#334155]"
              >
                <ChevronLeft size={16} /> Back to gallery
              </button>
            ) : (
              <p className="eyebrow text-[#94a3b8]">Session archive</p>
            )}
            <h2 className="text-[18px] font-extrabold tracking-[-.03em] text-[#1e293b] sm:text-[20px]">
              {inDetail ? 'Capture details' : (
                <>Captured samples <span className="mono text-[#475569]">{filteredRecords.length}</span></>
              )}
            </h2>
            <p className="mt-0.5 text-[10px] text-[#94a3b8]">
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
          <div className="review-filters shrink-0 border-b border-[#f0f0f0] bg-[#fafafa] px-4 py-3 sm:px-6">
            <div className="flex flex-wrap items-center gap-2">
              <span className="mr-1 text-[9px] font-bold uppercase tracking-[.1em] text-[#94a3b8]">Filter</span>
              {(['All', ...grades] as const).map((filter) => {
                const active = gradeFilter === filter;
                const label = filter === 'All' ? 'All' : filter === 'Invalid' ? 'Invalid' : `Grade ${filter}`;
                const count = gradeCounts[filter];
                return (
                  <button
                    key={filter}
                    type="button"
                    data-testid={`filter-grade-${filter.toLowerCase()}`}
                    onClick={() => setGradeFilter(filter)}
                    className={`focus-ring review-filter-pill ${active ? 'review-filter-pill-active' : ''}`}
                    style={active && filter !== 'All' ? { background: gradeColors[filter], borderColor: gradeColors[filter], color: '#fff' } : undefined}
                  >
                    {label}
                    <span className={`mono rounded-md px-1.5 py-0.5 text-[9px] ${active && filter !== 'All' ? 'bg-white/20' : 'bg-[#f1f5f9] text-[#64748b]'}`}>
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {!records.length ? (
            <div className="flex min-h-[320px] flex-col items-center justify-center px-6 py-12 text-center">
              <div className="mb-3 rounded-2xl bg-[#f8fafc] p-4 text-[#64748b]">
                <Archive size={28} />
              </div>
              <h3 className="text-[14px] font-extrabold text-[#334155]">Nothing captured yet</h3>
              <p className="mt-1 max-w-[260px] text-[11px] leading-4 text-[#94a3b8]">Completed samples will appear here for a quick quality check.</p>
            </div>
          ) : inDetail && selectedRecord ? (
            <div className="p-4 sm:p-6">
              <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_340px]">
                <div>
                  <div className="overflow-hidden rounded-[20px] border border-[#ececec] bg-[#fafafa] p-2.5">
                    {previews[selectedRecord.id] ? (
                      <img src={previews[selectedRecord.id]} alt={jpegFilename(selectedRecord)} className="aspect-[4/3] w-full rounded-[14px] object-cover" />
                    ) : (
                      <div className="flex aspect-[4/3] items-center justify-center rounded-[14px] bg-[#f1f5f9] text-[#94a3b8]">
                        <ImageIcon size={36} />
                      </div>
                    )}
                  </div>
                  <div className="mt-4 rounded-[18px] border border-[#ececec] bg-white p-4">
                    <p className="eyebrow text-[#94a3b8]">Filename</p>
                    <p className="mt-2 break-all font-mono text-[12px] font-bold leading-5 text-[#1e293b] sm:text-[13px]">{jpegFilename(selectedRecord)}</p>
                    <p className="mt-2 text-[10px] leading-5 text-[#94a3b8]">
                      Saved under tuncam / date-place / sample type / grade as date-site-sampletypecode-grade-sequence.jpg.
                    </p>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="rounded-[18px] border border-[#ececec] bg-white p-4">
                    <p className="eyebrow text-[#94a3b8]">Capture info</p>
                    <div className="mt-3 grid gap-2">
                      {[
                        { label: 'Sample type', value: selectedRecord.sampleType },
                        { label: 'Grade', value: gradeLabels[selectedRecord.grade] },
                        { label: 'Collection site', value: selectedRecord.site },
                        { label: 'Capture date', value: selectedRecord.date },
                        { label: 'Sequence', value: String(selectedRecord.sequence).padStart(3, '0') },
                        { label: 'Created at', value: new Date(selectedRecord.createdAt).toLocaleString() },
                      ].map((item) => (
                        <div key={item.label} className="rounded-xl border border-[#f1f5f9] bg-[#fafafa] px-3 py-2.5">
                          <p className="text-[9px] font-bold uppercase tracking-[.08em] text-[#94a3b8]">{item.label}</p>
                          <p className="mt-1 text-[11px] font-extrabold text-[#334155]">{item.value}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  <button
                    type="button"
                    data-testid={`button-delete-record-${selectedRecord.id}`}
                    onClick={() => handleDelete(selectedRecord.id)}
                    className="focus-ring flex w-full items-center justify-center gap-2 rounded-[16px] border border-[#f0d4c2] bg-[#fff7f1] px-4 py-3 text-[11px] font-extrabold text-[#b0634f] hover:bg-[#fff2ea]"
                  >
                    <Trash2 size={15} /> Delete this capture
                  </button>
                </div>
              </div>
            </div>
          ) : filteredRecords.length ? (
            <div className="review-gallery p-4 sm:p-6">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {filteredRecords.map((record) => (
                  <button
                    type="button"
                    key={record.id}
                    data-testid={`card-record-${record.id}`}
                    onClick={() => setSelectedId(record.id)}
                    className="review-gallery-card focus-ring group text-left"
                  >
                    <div className="relative aspect-square overflow-hidden rounded-[14px] bg-[#f1f5f9]">
                      {previews[record.id] ? (
                        <img
                          src={previews[record.id]}
                          alt={`${record.sampleType}, ${gradeLabels[record.grade]}`}
                          className="size-full object-cover transition duration-300 group-hover:scale-[1.03]"
                        />
                      ) : (
                        <div className="flex size-full items-center justify-center text-[#94a3b8]">
                          <ImageIcon size={22} />
                        </div>
                      )}
                      <span
                        className="absolute left-2 top-2 rounded-full px-2 py-0.5 text-[8px] font-extrabold text-white shadow-sm"
                        style={{ background: gradeColors[record.grade] }}
                      >
                        {record.grade === 'Invalid' ? '!' : record.grade}
                      </span>
                      <span className="absolute bottom-2 right-2 rounded-md bg-white/90 px-1.5 py-0.5 font-mono text-[8px] font-bold text-[#475569] shadow-sm backdrop-blur-sm">
                        #{String(record.sequence).padStart(3, '0')}
                      </span>
                    </div>
                    <div className="mt-2 px-0.5">
                      <p className="truncate font-mono text-[9px] font-bold text-[#334155]">{jpegFilename(record)}</p>
                      <p className="mt-0.5 truncate text-[8px] text-[#94a3b8]">{record.sampleType}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex min-h-[280px] flex-col items-center justify-center px-6 py-12 text-center">
              <div className="mb-3 rounded-2xl bg-[#f8fafc] p-4 text-[#94a3b8]">
                <SlidersHorizontal size={24} />
              </div>
              <h3 className="text-[14px] font-extrabold text-[#334155]">No samples in this filter</h3>
              <p className="mt-1 max-w-[240px] text-[11px] leading-4 text-[#94a3b8]">Try another grade or switch back to All.</p>
              <button type="button" onClick={() => setGradeFilter('All')} className="focus-ring mt-4 rounded-lg border border-[#e2e8f0] bg-white px-4 py-2 text-[10px] font-bold text-[#475569] hover:bg-[#f8fafc]">
                Show all captures
              </button>
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-[#f0f0f0] bg-[#fafafa] px-4 py-3 sm:px-6">
          <span className="text-[10px] text-[#94a3b8]">
            {inDetail ? 'Press Back to gallery to browse all captures.' : `${records.length} total · scroll to browse the archive`}
          </span>
          <div className="flex flex-wrap gap-2">
            <button type="button" data-testid="button-export-json-review" onClick={() => onExport('json')} className="focus-ring flex items-center gap-1.5 rounded-lg border border-[#d1e1e8] bg-white px-3 py-2 text-[10px] font-bold text-[#527084]">
              <Download size={13} /> JSON
            </button>
            <button type="button" data-testid="button-download-dataset-review" disabled={!records.length || exporting} onClick={onDownload} className="focus-ring flex items-center gap-1.5 rounded-lg bg-[#214e69] px-3 py-2 text-[10px] font-extrabold text-white disabled:opacity-40">
              <FileImage size={13} /> Download photos ZIP
            </button>
            <button type="button" data-testid="button-done-review" onClick={onClose} className="focus-ring rounded-lg border border-[#d1e1e8] bg-white px-4 py-2 text-[10px] font-extrabold text-[#214e69]">
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
function EndModal({ records, settings, exporting, onClose, onExport, onDownload }: { records: RecordItem[]; settings: SessionSettings; exporting: boolean; onClose: () => void; onExport: (format: 'csv' | 'json') => void; onDownload: () => void }) {
  const sampleName = exampleFilename(settings.site);
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-[#18354a]/40 p-4 backdrop-blur-sm">
      <div className="modal-in w-full max-w-[560px] overflow-hidden rounded-[26px] border border-white/70 bg-[#f9fcfd] shadow-[0_25px_80px_rgba(20,58,86,.24)]">
        <div className="blue-sheen p-6 text-white">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[.14em] text-white/70">Session wrap</p>
              <h2 className="mt-2 text-[25px] font-extrabold tracking-[-.05em]">Secure the day’s work.</h2>
              <p className="mt-1 text-[11px] text-white/75">Download the ZIP, extract it, then browse tuncam / date-place / sample type / grade for the photos.</p>
            </div>
            <Archive size={27} className="text-white/80" />
          </div>
        </div>
        <div className="space-y-4 p-6">
          <div className="grid grid-cols-3 gap-2">
            {[['Samples', records.length], ['Operator', settings.operator || '—'], ['Grader', settings.grader || '—']].map(([label, value]) => (
              <div key={String(label)} className="rounded-xl bg-[#eef6f9] p-3">
                <p className="eyebrow">{label}</p>
                <p className="mt-1 truncate text-[12px] font-extrabold text-[#38566a]">{value}</p>
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
              <li key={step} className="flex gap-3 rounded-[14px] border border-[#dceaf1] bg-white/80 px-3 py-2.5">
                <span className="mono flex size-6 shrink-0 items-center justify-center rounded-lg bg-[#e8f3ff] text-[10px] font-bold text-[#3d63cf]">{index + 1}</span>
                <p className="text-[11px] leading-4 text-[#4d6a7d]">{step}</p>
              </li>
            ))}
          </ol>
          <div className="flex gap-3 rounded-[15px] border border-[#f0d9c8] bg-[#fff8f2] p-3.5">
            <Upload size={17} className="mt-0.5 shrink-0 text-[#d08362]" />
            <div>
              <p className="text-[11px] font-extrabold text-[#805846]">Backup reminder</p>
              <p className="mt-1 text-[10px] leading-4 text-[#9e7662]">Copy today’s ZIP to a USB drive before leaving the landing center.</p>
            </div>
          </div>
          <button type="button" data-testid="button-download-dataset-end" disabled={!records.length || exporting} onClick={onDownload} className="focus-ring flex w-full items-center justify-center gap-2 rounded-xl bg-[#214e69] py-3.5 text-[12px] font-extrabold text-white disabled:opacity-40">
            <FileImage size={16} />{exporting ? 'Packing photos…' : 'Download photos ZIP'}
          </button>
          <div className="flex gap-2">
            <button type="button" data-testid="button-export-csv-end" onClick={() => onExport('csv')} className="focus-ring flex flex-1 items-center justify-center gap-2 rounded-xl border border-[#cfe1e9] bg-white py-3 text-[11px] font-extrabold text-[#4f7185]"><Download size={15} /> CSV</button>
            <button type="button" data-testid="button-export-json-end" onClick={() => onExport('json')} className="focus-ring flex flex-1 items-center justify-center gap-2 rounded-xl border border-[#cfe1e9] bg-white py-3 text-[11px] font-extrabold text-[#4f7185]"><Download size={15} /> JSON</button>
          </div>
          <button type="button" data-testid="button-close-end" onClick={onClose} className="focus-ring w-full rounded-xl border border-[#d5e5ee] bg-white py-3 text-[11px] font-extrabold text-[#214e69]">Continue session</button>
        </div>
      </div>
    </div>
  );
}
function ToolsModal({ settings, onClose, onInstall }: { settings: SessionSettings; onClose: () => void; onInstall?: () => Promise<void> }) {
  return <div className="fixed inset-0 z-30 flex items-center justify-center bg-[#18354a]/40 p-4 backdrop-blur-sm"><div className="modal-in w-full max-w-[460px] rounded-[24px] border border-white/70 bg-[#f9fcfd] p-6 shadow-[0_25px_80px_rgba(20,58,86,.24)]"><div className="flex items-start justify-between"><div><p className="eyebrow">Session tools</p><h2 className="mt-1 text-[19px] font-extrabold text-[#203e54]">Field instrument</h2></div><button type="button" data-testid="button-close-tools" onClick={onClose} className="focus-ring rounded-lg p-2 text-[#78919f] hover:bg-white"><X size={18} /></button></div><div className="mt-5 space-y-2"><ToolRow icon={<CloudOff size={16} />} title="Offline-first storage" detail="Captures stay in this browser and optional local folder." /><ToolRow icon={<ShieldCheck size={16} />} title="No auto-detect" detail="Camera and shutter are manual only. Nothing captures itself." /><ToolRow icon={<FolderOpen size={16} />} title="Folder access" detail={settings.storage} /></div>{onInstall && <button type="button" data-testid="button-install-tools" onClick={onInstall} className="focus-ring mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-[#e7f6fb] py-3 text-[11px] font-extrabold text-[#257d9f]"><Download size={15} /> Install TUNCAM on this device</button>}<button type="button" data-testid="button-done-tools" onClick={onClose} className="focus-ring mt-2 w-full rounded-xl bg-[#214e69] py-3 text-[11px] font-extrabold text-white">Done</button></div></div>;
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
  return <div className="fixed inset-0 z-30 flex items-center justify-center bg-[#18354a]/45 p-4 backdrop-blur-sm"><div className="modal-in w-full max-w-[560px] overflow-hidden rounded-[26px] border border-white/70 bg-[#f9fcfd] shadow-[0_25px_80px_rgba(20,58,86,.24)]"><div className="flex items-center justify-between border-b border-[#e1edf2] px-5 py-4"><div><p className="eyebrow">Keyboard shortcuts</p><h2 className="mt-1 text-[18px] font-extrabold text-[#203e54]">Faster field workflow</h2></div><button type="button" onClick={onClose} className="focus-ring rounded-lg p-2 text-[#78919f] hover:bg-white"><X size={18} /></button></div><div className="grid gap-2 p-5">{items.map(([key, description]) => <div key={key} className="flex items-center justify-between rounded-[18px] border border-[#dde9f1] bg-white/80 px-4 py-3"><span className="text-[11px] font-bold text-[#49677b]">{description}</span><span className="mono rounded-lg bg-[#eef4ff] px-2 py-1 text-[10px] font-bold text-[#4e63cf]">{key}</span></div>)}</div><div className="border-t border-[#e1edf2] bg-[#f0f6f9] px-5 py-3 text-[10px] text-[#7f95a5]">Capture stays manual. Shortcuts only speed up actions you explicitly trigger.</div></div></div>;
}
function ToolRow({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return <div className="flex items-center gap-3 rounded-xl border border-[#deebf0] bg-white/70 p-3"><div className="rounded-lg bg-[#eaf6fa] p-2 text-[#3b9dbc]">{icon}</div><div className="min-w-0"><p className="text-[11px] font-extrabold text-[#456276]">{title}</p><p className="truncate text-[10px] text-[#849aa8]">{detail}</p></div></div>;
}
function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export default App;
