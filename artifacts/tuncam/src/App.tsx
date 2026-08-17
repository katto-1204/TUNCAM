import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Aperture, Archive, BadgeCheck, Camera, Check, ChevronDown, CircleAlert,
  ClipboardList, CloudOff, Download, FolderOpen, Gauge, HardDrive,
  Image as ImageIcon, Info, MonitorDown, Pause, Plus, RefreshCw,
  ScanLine, Settings2, ShieldCheck, SlidersHorizontal, Trash2,
  Undo2, Upload, UserRound, Video, X, Zap,
} from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';

const queryClient = new QueryClient();
const STORAGE_KEY = 'tuncam-capture-records-v1';
const SETTINGS_KEY = 'tuncam-session-settings-v1';

type SampleType = 'Sashibo Core' | 'Tail-Cut';
type Grade = 'A' | 'B' | 'C' | 'Invalid';
type CameraState = 'loading' | 'ready' | 'denied' | 'missing';
type RecordItem = {
  id: string;
  filename: string;
  date: string;
  site: string;
  sampleType: SampleType;
  grade: Grade;
  sequence: number;
  createdAt: string;
  image?: string;
};
type SessionSettings = {
  site: string;
  operator: string;
  grader: string;
  storage: string;
  sampleType: SampleType | '';
};
type ToastItem = { id: number; message: string; tone?: 'info' | 'success' | 'warning' };
type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

const defaultSettings: SessionSettings = {
  site: 'Bangkerohan, General Santos City',
  operator: '',
  grader: '',
  storage: 'Browser storage · this device',
  sampleType: '',
};
const grades: Grade[] = ['A', 'B', 'C', 'Invalid'];
const gradeLabels: Record<Grade, string> = { A: 'Grade A', B: 'Grade B', C: 'Grade C', Invalid: 'Invalid' };
const gradeColors: Record<Grade, string> = {
  A: '#1594d0',
  B: '#4d72dc',
  C: '#8a6bd5',
  Invalid: '#dc776f',
};

function today() {
  return new Date().toISOString().slice(0, 10);
}
function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 34) || 'site';
}
function sampleCode(type: SampleType) {
  return type === 'Sashibo Core' ? 'sc' : 'tc';
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
  const [records, setRecords] = useState<RecordItem[]>(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
  });
  const [cameraState, setCameraState] = useState<CameraState>('loading');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDevice, setSelectedDevice] = useState('');
  const [cameraRetry, setCameraRetry] = useState(0);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [capturedImage, setCapturedImage] = useState<string | undefined>();
  const [isGradeOpen, setIsGradeOpen] = useState(false);
  const [isReviewOpen, setIsReviewOpen] = useState(false);
  const [isEndOpen, setIsEndOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isAwake, setIsAwake] = useState(false);
  const [wakeSupport, setWakeSupport] = useState<'unknown' | 'supported' | 'unsupported'>('unknown');
  const [storageStatus, setStorageStatus] = useState<{ used?: number; quota?: number; low: boolean }>({ low: false });
  const [folderChosen, setFolderChosen] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  const toastId = useRef(1);

  const notify = useCallback((message: string, tone: ToastItem['tone'] = 'info') => {
    const id = toastId.current++;
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 3200);
  }, []);

  const counts = useMemo(() => grades.reduce((all, grade) => {
    all[grade] = records.filter((record) => record.grade === grade).length;
    return all;
  }, {} as Record<Grade, number>), [records]);
  const typeCounts = useMemo(() => ({
    'Sashibo Core': records.filter((record) => record.sampleType === 'Sashibo Core').length,
    'Tail-Cut': records.filter((record) => record.sampleType === 'Tail-Cut').length,
  }), [records]);
  const readyToCapture = Boolean(settings.site && settings.operator.trim() && settings.grader.trim() && settings.sampleType && cameraState === 'ready');
  const currentSequence = records.length ? Math.max(...records.map((record) => record.sequence)) + 1 : 1;

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  }, [records]);
  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);
  useEffect(() => {
    const onInstall = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPrompt); };
    window.addEventListener('beforeinstallprompt', onInstall);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => undefined);
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
    const bootCamera = async () => {
      if (!navigator.mediaDevices?.getUserMedia) { setCameraState('missing'); return; }
      setCameraState('loading');
      try {
        const nextStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 }, deviceId: selectedDevice ? { exact: selectedDevice } : undefined }, audio: false });
        if (!mounted) { nextStream.getTracks().forEach((track) => track.stop()); return; }
        setStream((old) => { old?.getTracks().forEach((track) => track.stop()); return nextStream; });
        setCameraState('ready');
        const listed = await navigator.mediaDevices.enumerateDevices();
        setDevices(listed.filter((device) => device.kind === 'videoinput'));
      } catch {
        if (mounted) setCameraState('denied');
      }
    };
    bootCamera();
    return () => { mounted = false; };
  }, [selectedDevice, cameraRetry]);
  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
      videoRef.current.play().catch(() => undefined);
    }
  }, [stream]);
  useEffect(() => () => { stream?.getTracks().forEach((track) => track.stop()); wakeLockRef.current?.release().catch(() => undefined); }, [stream]);
  useEffect(() => {
    const handleKeys = (event: KeyboardEvent) => {
      if (isGradeOpen) {
        const index = Number(event.key) - 1;
        if (index >= 0 && index < grades.length) { event.preventDefault(); finalizeGrade(grades[index]); }
        return;
      }
      if (event.code === 'Space' && readyToCapture && !isEndOpen && !isReviewOpen) { event.preventDefault(); captureFrame(); }
    };
    window.addEventListener('keydown', handleKeys);
    return () => window.removeEventListener('keydown', handleKeys);
  });

  const finalizeGrade = (grade: Grade) => {
    if (!settings.sampleType) return;
    const date = today();
    const sequence = currentSequence;
    const filename = `${date}-${slug(settings.site)}-${sampleCode(settings.sampleType)}-${grade}-${String(sequence).padStart(3, '0')}.jpg`;
    const record: RecordItem = {
      id: `${Date.now()}-${sequence}`,
      filename,
      date,
      site: settings.site,
      sampleType: settings.sampleType,
      grade,
      sequence,
      createdAt: new Date().toISOString(),
      image: capturedImage,
    };
    setRecords((current) => [record, ...current]);
    setCapturedImage(undefined);
    setIsGradeOpen(false);
    setIsCapturing(false);
    notify(`${filename} saved to ${settings.sampleType} / Grade${grade === 'Invalid' ? '' : grade}`, 'success');
  };

  const captureFrame = () => {
    if (!readyToCapture || !videoRef.current || !canvasRef.current || isGradeOpen) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const context = canvas.getContext('2d');
    if (!context) return;
    setIsCapturing(true);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    setCapturedImage(canvas.toDataURL('image/jpeg', .9));
    setIsGradeOpen(true);
  };

  const undoLast = () => {
    if (!records.length) return;
    const [last, ...rest] = records;
    setRecords(rest);
    notify(`${last.filename} removed. Tally restored.`, 'warning');
  };
  const deleteRecord = (id: string) => {
    const item = records.find((record) => record.id === id);
    setRecords((current) => current.filter((record) => record.id !== id));
    if (item) notify(`${item.filename} removed.`, 'warning');
  };
  const exportManifest = (format: 'csv' | 'json') => {
    const manifest = records.map(({ image, ...record }) => ({ ...record, operator: settings.operator, grader: settings.grader, storage: settings.storage, folder: `${record.date}/${record.sampleType}/${record.grade === 'Invalid' ? 'Invalid' : `Grade${record.grade}`}` }));
    const content = format === 'json'
      ? JSON.stringify({ session: { ...settings, date: today() }, records: manifest }, null, 2)
      : ['filename,date,site,sample_type,grade,sequence,operator,grader,folder', ...manifest.map((record) => [record.filename, record.date, record.site, record.sampleType, record.grade, record.sequence, record.operator, record.grader, record.folder].map((value) => `"${String(value).replaceAll('"', '""')}"`).join(','))].join('\n');
    const blob = new Blob([content], { type: format === 'json' ? 'application/json' : 'text/csv' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `tuncam-${today()}-manifest.${format}`;
    link.click();
    URL.revokeObjectURL(link.href);
    notify(`${format.toUpperCase()} manifest downloaded.`, 'success');
  };
  const chooseFolder = async () => {
    const picker = (window as unknown as { showDirectoryPicker?: () => Promise<unknown> }).showDirectoryPicker;
    if (!picker) { notify('Folder access is not available in this browser. Browser storage remains active.', 'warning'); return; }
    try {
      await picker();
      setFolderChosen(true);
      setSettings((current) => ({ ...current, storage: 'Selected local folder · browser permission granted' }));
      notify('Local folder selected for this session.', 'success');
    } catch { notify('Folder selection cancelled. Nothing changed.', 'info'); }
  };
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
              <p className="truncate text-[10px] text-[#7891a4]">Standardized tuna sample capture</p>
            </div>
          </div>
          <div className="hidden items-center gap-5 lg:flex">
            <StatusChip icon={<CloudOff size={14} />} label="Offline ready" tone="cyan" />
            <StatusChip icon={<ShieldCheck size={14} />} label="Local only" tone="green" />
            <span className="h-7 w-px bg-[#dbe8ef]" />
            <div className="text-right"><p className="eyebrow">Session date</p><p className="mono text-[12px] font-medium text-[#34536a]">{today()}</p></div>
          </div>
          <div className="flex items-center gap-2">
            {installPrompt && <button data-testid="button-install-app" onClick={installApp} className="focus-ring hidden items-center gap-2 rounded-xl border border-[#b9ddea] bg-white/80 px-3 py-2 text-[11px] font-bold text-[#1579a8] sm:flex"><Download size={14} /> Install</button>}
            <button data-testid="button-open-settings" onClick={() => setIsSettingsOpen(true)} className="focus-ring flex size-9 items-center justify-center rounded-xl border border-[#d7e7ef] bg-white/80 text-[#628096] transition hover:bg-white hover:text-[#167db0]" aria-label="Open session tools"><Settings2 size={17} /></button>
            <div className="hidden size-9 items-center justify-center rounded-xl bg-[#e7f0f6] text-[11px] font-extrabold text-[#3b5c75] sm:flex">{settings.operator ? settings.operator.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase() : 'OP'}</div>
          </div>
        </header>

        <section className="mt-3 grid gap-3 xl:grid-cols-[270px_minmax(420px,1fr)_322px] lg:grid-cols-[245px_minmax(380px,1fr)_285px]">
          <aside className="soft-card rounded-[22px] p-4">
            <div className="mb-4 flex items-start justify-between"><div><p className="eyebrow">01 / Session setup</p><h2 className="mt-1 text-[16px] font-extrabold tracking-[-.03em] text-[#203c53]">Capture context</h2></div><div className="rounded-xl bg-[#eff8fc] p-2 text-[#2aa6d7]"><ClipboardList size={17} /></div></div>
            <div className="space-y-3">
              <label><span className="field-label">Collection site <span className="text-[#d87871]">*</span></span><select data-testid="select-collection-site" value={settings.site} onChange={(event) => { if (event.target.value === '__new') { setSettings({ ...settings, site: '' }); setCustomSite(''); } else setSettings({ ...settings, site: event.target.value }); }} className="field-control"><option>Bangkerohan, General Santos City</option><option>Fish Port, General Santos City</option><option>Navotas Fish Port, Metro Manila</option>{customSite && <option value={customSite}>{customSite}</option>}<option value="__new">Add a new site…</option></select></label>
              {!settings.site && <div className="relative"><Plus size={15} className="absolute left-3 top-3 text-[#88a1b1]" /><input data-testid="input-new-site" value={customSite} onChange={(event) => { setCustomSite(event.target.value); setSettings({ ...settings, site: event.target.value }); }} className="field-control pl-9" placeholder="e.g. Makar Wharf, Gensan" /></div>}
              <label><span className="field-label">Operator name <span className="text-[#d87871]">*</span></span><div className="relative"><UserRound size={15} className="absolute left-3 top-3 text-[#88a1b1]" /><input data-testid="input-operator-name" value={settings.operator} onChange={(event) => setSettings({ ...settings, operator: event.target.value })} className="field-control pl-9" placeholder="Who is capturing?" /></div></label>
              <label><span className="field-label">Expert grader <span className="text-[#d87871]">*</span></span><div className="relative"><BadgeCheck size={15} className="absolute left-3 top-3 text-[#88a1b1]" /><input data-testid="input-grader-name" value={settings.grader} onChange={(event) => setSettings({ ...settings, grader: event.target.value })} className="field-control pl-9" placeholder="Who is grading?" /></div></label>
              <label><span className="field-label">Storage location</span><button data-testid="button-choose-folder" onClick={chooseFolder} className="focus-ring flex h-10 w-full items-center gap-2 rounded-xl border border-[#d5e5ee] bg-[#f7fbfd] px-3 text-left text-[11px] text-[#557187] hover:border-[#7bc7e5]"><FolderOpen size={15} className="shrink-0 text-[#319ccc]" /><span className="min-w-0 flex-1 truncate">{folderChosen ? 'Local folder selected' : settings.storage}</span><ChevronDown size={14} className="text-[#9ab1c0]" /></button></label>
              <div><span className="field-label">Sample type <span className="text-[#d87871]">*</span></span><div className="grid grid-cols-2 gap-2"><SampleOption value="Sashibo Core" selected={settings.sampleType === 'Sashibo Core'} onClick={() => setSettings({ ...settings, sampleType: 'Sashibo Core' })} code="SC" /><SampleOption value="Tail-Cut" selected={settings.sampleType === 'Tail-Cut'} onClick={() => setSettings({ ...settings, sampleType: 'Tail-Cut' })} code="TC" /></div></div>
            </div>
            <div className={`mt-4 rounded-[15px] border px-3 py-2.5 ${readyToCapture ? 'border-[#bde7da] bg-[#f0fbf7]' : 'border-[#e2edf2] bg-[#f8fbfc]'}`}><div className="flex items-center gap-2"><span className={`size-2 rounded-full ${readyToCapture ? 'status-breathe bg-[#29b685]' : 'bg-[#c6d5de]'}`} /><span className="text-[11px] font-bold text-[#49677b]">{readyToCapture ? 'Ready for capture' : 'Complete required fields'}</span></div><p className="mt-1 text-[10px] leading-4 text-[#8198a8]">{readyToCapture ? 'Spacebar is armed. Grade immediately after each frame.' : 'Site, operator, grader, sample type and camera are required.'}</p></div>
          </aside>

          <section className="soft-card min-w-0 rounded-[22px] p-3 sm:p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><p className="eyebrow">02 / Live view</p><div className="mt-1 flex items-center gap-2"><h2 className="text-[16px] font-extrabold tracking-[-.03em] text-[#203c53]">Imaging chamber</h2><span className={`rounded-full px-2 py-1 text-[9px] font-extrabold uppercase tracking-[.08em] ${cameraState === 'ready' ? 'bg-[#e5f8f2] text-[#238866]' : 'bg-[#fff3e8] text-[#bc7449]'}`}>{cameraState === 'ready' ? 'Live feed' : cameraState === 'loading' ? 'Connecting' : 'No camera'}</span></div></div><div className="flex items-center gap-2"><button data-testid="button-refresh-camera" onClick={() => { setSelectedDevice(''); setCameraState('loading'); setCameraRetry((value) => value + 1); }} className="focus-ring flex size-8 items-center justify-center rounded-lg border border-[#dce9ef] bg-white/80 text-[#6e899b] hover:text-[#1784b7]" aria-label="Refresh camera"><RefreshCw size={14} /></button><select data-testid="select-camera-device" value={selectedDevice} onChange={(event) => setSelectedDevice(event.target.value)} className="h-8 max-w-[140px] rounded-lg border border-[#dce9ef] bg-white/80 px-2 text-[10px] text-[#587185]" aria-label="Camera device"><option value="">Default camera</option>{devices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}</select></div></div>
            <div className={`relative aspect-[16/10] min-h-[290px] overflow-hidden rounded-[18px] bg-[#dce9ee] ${isCapturing ? 'capture-pulse' : ''}`}>
              {cameraState === 'ready' ? <video ref={videoRef} muted playsInline className="absolute inset-0 size-full object-cover" data-testid="video-camera-preview" /> : <CameraEmpty state={cameraState} onRetry={() => { setCameraState('loading'); setCameraRetry((value) => value + 1); }} />}
              {cameraState === 'ready' && <><div className="pointer-events-none absolute inset-[17%_16%] rounded-[18px] border-2 border-white/90 shadow-[0_0_0_999px_rgba(28,72,95,.16)]"><span className="absolute -left-1 -top-1 size-5 border-l-2 border-t-2 border-[#62dded]" /><span className="absolute -right-1 -top-1 size-5 border-r-2 border-t-2 border-[#62dded]" /><span className="absolute -bottom-1 -left-1 size-5 border-b-2 border-l-2 border-[#62dded]" /><span className="absolute -bottom-1 -right-1 size-5 border-b-2 border-r-2 border-[#62dded]" /></div><div className="pointer-events-none absolute inset-x-[16%] top-1/2 h-px bg-white/35" /><div className="pointer-events-none absolute inset-y-[17%] left-1/2 w-px bg-white/35" /><div className="scan-line pointer-events-none absolute left-[16%] right-[16%] top-1/2 h-px bg-[#69e0ee]/70" /><div className="absolute left-4 top-4 flex items-center gap-2 rounded-full bg-[#193b4d]/60 px-2.5 py-1.5 text-[9px] font-bold text-white backdrop-blur"><span className="size-1.5 rounded-full bg-[#5ce3b7]" /> ALIGN SAMPLE WITHIN GUIDE</div><div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-[#193b4d]/60 px-3 py-1.5 text-[10px] font-medium text-white/90 backdrop-blur">Platform guide · 1:1 crop region</div></>}
            </div>
            <canvas ref={canvasRef} className="hidden" />
            <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-3"><div className="hidden items-center gap-2 sm:flex"><div className="rounded-lg bg-[#eaf5fa] p-2 text-[#3b9fca]"><ScanLine size={15} /></div><div><p className="text-[10px] font-bold text-[#4b687d]">Framing guide active</p><p className="text-[9px] text-[#8ca1af]">Center sample on white platform</p></div></div><button data-testid="button-capture" disabled={!readyToCapture} onClick={captureFrame} className={`focus-ring group relative flex h-[62px] min-w-[170px] items-center justify-center gap-3 rounded-[18px] px-5 text-white shadow-[0_12px_22px_rgba(27,142,204,.25)] transition hover:-translate-y-0.5 disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-45 ${readyToCapture ? 'blue-sheen' : 'bg-[#afc6d2]'}`}><span className="flex size-9 items-center justify-center rounded-xl border border-white/30 bg-white/15"><Camera size={19} /></span><span className="text-left"><span className="block text-[12px] font-extrabold">Capture sample</span><span className="mono block text-[9px] opacity-80">SPACEBAR</span></span></button><div className="flex justify-end"><button data-testid="button-undo-last" disabled={!records.length} onClick={undoLast} className="focus-ring flex items-center gap-2 rounded-xl border border-[#d8e7ee] bg-white/70 px-3 py-2.5 text-[10px] font-bold text-[#617b8d] hover:bg-white disabled:opacity-40"><Undo2 size={14} /> <span className="hidden sm:inline">Undo last</span></button></div></div>
            {!readyToCapture && <p className="mt-2 text-center text-[10px] text-[#8aa0ae]">Capture activates when all required metadata is ready and a live camera is connected.</p>}
          </section>

          <aside className="space-y-3">
            <div className="soft-card rounded-[22px] p-4"><div className="flex items-start justify-between"><div><p className="eyebrow">03 / Session pulse</p><h2 className="mt-1 text-[16px] font-extrabold tracking-[-.03em] text-[#203c53]">Today’s tally</h2></div><div className="blue-sheen rounded-xl p-2 text-white"><Gauge size={17} /></div></div><div className="mt-4 grid grid-cols-4 gap-1.5">{grades.map((grade) => <div key={grade} className="rounded-xl bg-[#f5f9fb] px-2 py-2.5 text-center"><div className="mx-auto mb-1 flex size-6 items-center justify-center rounded-lg text-[11px] font-extrabold text-white" style={{ background: gradeColors[grade] }}>{grade === 'Invalid' ? '!' : grade}</div><p data-testid={`text-count-${grade.toLowerCase()}`} className="mono text-[18px] font-medium text-[#24435a]">{counts[grade]}</p><p className="mt-0.5 text-[8px] font-bold uppercase tracking-[.06em] text-[#91a6b3]">{grade === 'Invalid' ? 'bad' : 'grade'}</p></div>)}</div><div className="mt-3 flex items-center justify-between border-t border-[#e6eef3] pt-3"><span className="text-[11px] font-bold text-[#577286]">Total captured</span><span data-testid="text-total-captured" className="mono text-[18px] font-medium text-[#1c75ac]">{records.length.toString().padStart(3, '0')}</span></div></div>
            <div className="soft-card rounded-[22px] p-4"><div className="flex items-center justify-between"><div><p className="eyebrow">Progress / target 800</p><p className="mt-1 text-[12px] font-bold text-[#426278]">Class balance</p></div><SlidersHorizontal size={16} className="text-[#78a1b7]" /></div><div className="mt-3 space-y-3">{(['Sashibo Core', 'Tail-Cut'] as SampleType[]).map((type) => <div key={type}><div className="mb-1.5 flex items-center justify-between text-[10px]"><span className="font-bold text-[#5c7587]">{type}</span><span className="mono text-[#849aa8]">{typeCounts[type]} / 3,200</span></div><div className="h-2 overflow-hidden rounded-full bg-[#e5eff4]"><div className="h-full rounded-full bg-gradient-to-r from-[#39b9e7] to-[#4a78df] transition-all duration-500" style={{ width: `${Math.min(100, typeCounts[type] / 32)}%` }} /></div></div>)}</div><div className="mt-4 grid grid-cols-2 gap-2">{grades.slice(0, 3).map((grade) => <div key={grade} className="flex items-center gap-2 text-[9px] text-[#7d94a3]"><span className="size-1.5 rounded-full" style={{ background: gradeColors[grade] }} /> {gradeLabels[grade]} target</div>)}</div></div>
            <div className="soft-card rounded-[22px] p-4"><div className="flex items-center justify-between"><div className="flex items-center gap-2"><HardDrive size={16} className={storageStatus.low ? 'text-[#d8796e]' : 'text-[#3c9cbb]'} /><span className="text-[11px] font-extrabold text-[#466479]">Local storage</span></div><span className={`rounded-full px-2 py-1 text-[9px] font-bold ${storageStatus.low ? 'bg-[#fff0ed] text-[#bd685f]' : 'bg-[#ebf8f4] text-[#2e8c70]'}`}>{storageStatus.low ? 'Review soon' : 'Healthy'}</span></div><p className="mt-2 text-[10px] leading-4 text-[#8499a8]">{storageStatus.quota ? `${formatBytes(storageStatus.used || 0)} used of ${formatBytes(storageStatus.quota)} browser quota.` : 'Browser storage estimate will appear when supported.'}</p>{storageStatus.low && <div className="mt-2 flex gap-2 rounded-lg bg-[#fff5f1] p-2 text-[10px] text-[#ae6259]"><CircleAlert size={14} className="shrink-0" /> Export a manifest and move captures to a backup drive.</div>}</div>
            <div className="grid grid-cols-2 gap-2"><button data-testid="button-open-review" onClick={() => setIsReviewOpen(true)} className="focus-ring flex items-center justify-center gap-2 rounded-xl border border-[#d5e5ed] bg-white/80 py-3 text-[10px] font-extrabold text-[#4c6b7f] hover:bg-white"><ImageIcon size={15} /> Review <span className="rounded-full bg-[#eaf4f8] px-1.5 py-0.5 text-[9px] text-[#4182a1]">{records.length}</span></button><button data-testid="button-end-session" onClick={() => setIsEndOpen(true)} className="focus-ring flex items-center justify-center gap-2 rounded-xl border border-[#e2dfe8] bg-white/80 py-3 text-[10px] font-extrabold text-[#766587] hover:bg-white"><Archive size={15} /> End session</button></div>
          </aside>
        </section>

        <footer className="mt-3 flex flex-wrap items-center justify-between gap-3 px-1 pb-2 text-[10px] text-[#7d95a5]"><div className="flex items-center gap-3"><span className="flex items-center gap-1.5"><Zap size={13} className="text-[#28a5d0]" /> Capture-to-grade loop</span><span className="hidden h-3 w-px bg-[#cbdde6] sm:inline" /><span className="hidden items-center gap-1.5 sm:flex"><ShieldCheck size={13} className="text-[#49a88a]" /> No cloud sync</span></div><div className="flex items-center gap-3"><button data-testid="button-toggle-awake" onClick={toggleAwake} className={`focus-ring flex items-center gap-1.5 rounded-lg px-2 py-1 font-bold ${isAwake ? 'bg-[#e5f8f2] text-[#25886e]' : 'hover:bg-white/70'}`}>{isAwake ? <Pause size={12} /> : <MonitorDown size={12} />}{isAwake ? 'Awake on' : 'Prevent sleep'}</button>{wakeSupport === 'unsupported' && <span className="text-[#b47a63]">Browser support unavailable</span>}<span className="mono">TUNCAM v1.0</span></div></footer>
      </main>
      {isGradeOpen && <GradeModal image={capturedImage} onSelect={finalizeGrade} onCancel={() => { setIsGradeOpen(false); setCapturedImage(undefined); setIsCapturing(false); }} />}
      {isReviewOpen && <ReviewModal records={records} onClose={() => setIsReviewOpen(false)} onDelete={deleteRecord} onExport={exportManifest} />}
      {isEndOpen && <EndModal records={records} settings={settings} onClose={() => setIsEndOpen(false)} onExport={exportManifest} />}
      {isSettingsOpen && <ToolsModal settings={settings} onClose={() => setIsSettingsOpen(false)} onInstall={installPrompt ? installApp : undefined} />}
      <div className="fixed bottom-4 left-1/2 z-50 flex w-[min(92vw,390px)] -translate-x-1/2 flex-col gap-2">{toasts.map((toast) => <div key={toast.id} className={`toast-in flex items-center gap-2 rounded-xl border px-3 py-2.5 text-[11px] font-bold shadow-[0_12px_30px_rgba(38,80,112,.16)] ${toast.tone === 'success' ? 'border-[#b9e8d7] bg-[#f0fbf7] text-[#267f69]' : toast.tone === 'warning' ? 'border-[#f0d4c2] bg-[#fff7f1] text-[#a66b54]' : 'border-[#c8e4ee] bg-white text-[#4c6c80]'}`}><Info size={14} /> {toast.message}</div>)}</div>
    </div>
  );
}

function StatusChip({ icon, label, tone }: { icon: ReactNode; label: string; tone: 'cyan' | 'green' }) {
  return <span className={`flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[10px] font-bold ${tone === 'cyan' ? 'bg-[#e8f7fc] text-[#2483ac]' : 'bg-[#eaf8f3] text-[#2a8b6c]'}`}>{icon}{label}</span>;
}
function SampleOption({ value, selected, onClick, code }: { value: SampleType; selected: boolean; onClick: () => void; code: string }) {
  return <button data-testid={`button-sample-${code.toLowerCase()}`} onClick={onClick} className={`focus-ring rounded-xl border p-2.5 text-left transition ${selected ? 'border-[#53b9df] bg-[#e9f8fc] shadow-[0_4px_12px_rgba(47,163,207,.1)]' : 'border-[#d9e6ed] bg-white/60 hover:bg-white'}`}><div className="flex items-center justify-between"><span className={`flex size-6 items-center justify-center rounded-lg text-[9px] font-extrabold ${selected ? 'blue-sheen text-white' : 'bg-[#eaf2f6] text-[#658196]'}`}>{code}</span>{selected && <Check size={14} className="text-[#1a9bcb]" />}</div><p className="mt-2 text-[10px] font-extrabold text-[#47647a]">{value}</p></button>;
}
function CameraEmpty({ state, onRetry }: { state: CameraState; onRetry: () => void }) {
  const text = state === 'loading' ? 'Connecting to camera…' : state === 'denied' ? 'Camera permission needed' : 'No camera detected';
  const detail = state === 'denied' ? 'Allow camera access in your browser, then try again.' : state === 'missing' ? 'This browser does not expose a camera API. Connect a supported webcam or continue reviewing local captures.' : 'Connect a webcam to start the live capture loop.';
  return <div className="absolute inset-0 flex items-center justify-center bg-[radial-gradient(circle_at_50%_36%,#edf7fa,#d8e5eb)]"><div className="max-w-[250px] text-center"><div className="mx-auto mb-3 flex size-14 items-center justify-center rounded-2xl border border-white/80 bg-white/60 text-[#5f91a9] shadow-sm">{state === 'loading' ? <RefreshCw className="animate-spin" size={25} /> : <Video size={25} />}</div><p className="text-[13px] font-extrabold text-[#496879]">{text}</p><p className="mt-1 text-[10px] leading-4 text-[#73909f]">{detail}</p>{state !== 'loading' && <button data-testid="button-camera-retry" onClick={onRetry} className="focus-ring mt-3 rounded-lg bg-white/80 px-3 py-2 text-[10px] font-bold text-[#2787ad] shadow-sm">Try camera again</button>}</div></div>;
}
function GradeModal({ image, onSelect, onCancel }: { image?: string; onSelect: (grade: Grade) => void; onCancel: () => void }) {
  return <div className="fixed inset-0 z-40 flex items-center justify-center bg-[#18354a]/45 p-4 backdrop-blur-sm"><div className="modal-in w-full max-w-[620px] overflow-hidden rounded-[24px] border border-white/70 bg-[#f9fcfd] shadow-[0_25px_80px_rgba(20,58,86,.28)]"><div className="flex items-start justify-between border-b border-[#e4edf2] px-5 py-4 sm:px-6"><div><p className="eyebrow text-[#288bab]">Capture held · label required</p><h2 className="mt-1 text-[20px] font-extrabold tracking-[-.04em] text-[#1f3c52]">How would you grade this sample?</h2><p className="mt-1 text-[11px] text-[#77909e]">Choose one label to save the image and continue.</p></div><div className="rounded-xl bg-[#eaf7fb] p-2 text-[#299ac4]"><ClipboardList size={18} /></div></div><div className="grid gap-4 p-5 sm:grid-cols-[160px_1fr] sm:p-6">{image ? <img src={image} alt="Captured tuna sample awaiting grade" className="aspect-square w-full rounded-[15px] border border-[#dbe8ee] object-cover" /> : <div className="flex aspect-square items-center justify-center rounded-[15px] bg-[#eaf1f5] text-[#7a98aa]"><ImageIcon /></div>}<div className="grid grid-cols-2 gap-2.5">{grades.map((grade, index) => <button key={grade} data-testid={`button-grade-${grade.toLowerCase()}`} onClick={() => onSelect(grade)} className="focus-ring group flex min-h-[86px] flex-col items-start justify-between rounded-[15px] border border-[#d8e6ed] bg-white p-3 text-left shadow-[0_4px_12px_rgba(38,83,109,.04)] transition hover:-translate-y-0.5 hover:border-[#7dc8e1] hover:shadow-[0_9px_20px_rgba(38,83,109,.11)]"><div className="flex w-full items-center justify-between"><span className="flex size-8 items-center justify-center rounded-xl text-[13px] font-extrabold text-white" style={{ background: gradeColors[grade] }}>{grade === 'Invalid' ? '!' : grade}</span><span className="mono text-[10px] text-[#a0b1bb]">{index + 1}</span></div><span className="text-[11px] font-extrabold text-[#486579]">{gradeLabels[grade]}</span></button>)}</div></div><div className="flex items-center justify-between bg-[#f0f6f9] px-5 py-3 text-[10px] text-[#78909e] sm:px-6"><span className="flex items-center gap-2"><Zap size={13} className="text-[#2aa4ce]" /> Keyboard ready: 1 / 2 / 3 / 4</span><button data-testid="button-cancel-capture" onClick={onCancel} className="focus-ring font-bold text-[#6d8493] hover:text-[#287a9f]">Discard frame</button></div></div></div>;
}
function ReviewModal({ records, onClose, onDelete, onExport }: { records: RecordItem[]; onClose: () => void; onDelete: (id: string) => void; onExport: (format: 'csv' | 'json') => void }) {
  return <div className="fixed inset-0 z-30 flex items-center justify-center bg-[#18354a]/40 p-4 backdrop-blur-sm"><div className="modal-in flex max-h-[min(760px,90dvh)] w-full max-w-[800px] flex-col overflow-hidden rounded-[24px] border border-white/70 bg-[#f8fbfc] shadow-[0_25px_80px_rgba(20,58,86,.24)]"><div className="flex items-center justify-between border-b border-[#e1edf2] px-5 py-4"><div><p className="eyebrow">Session review</p><h2 className="mt-1 text-[18px] font-extrabold text-[#203e54]">Captured samples <span className="mono text-[#298db6]">{records.length}</span></h2></div><div className="flex items-center gap-2"><button data-testid="button-export-csv-review" onClick={() => onExport('csv')} className="focus-ring hidden items-center gap-1.5 rounded-lg border border-[#d3e4eb] bg-white px-2.5 py-2 text-[10px] font-bold text-[#527084] sm:flex"><Download size={13} /> CSV</button><button data-testid="button-close-review" onClick={onClose} className="focus-ring rounded-lg p-2 text-[#78919f] hover:bg-white"><X size={18} /></button></div></div><div className="flex-1 overflow-y-auto p-5">{records.length ? <div className="grid gap-2.5 sm:grid-cols-2">{records.map((record) => <div key={record.id} data-testid={`card-record-${record.id}`} className="flex items-center gap-3 rounded-[15px] border border-[#dce9ef] bg-white/75 p-2.5">{record.image ? <img src={record.image} alt={`${record.sampleType}, ${gradeLabels[record.grade]}`} className="size-16 rounded-xl object-cover" /> : <div className="flex size-16 items-center justify-center rounded-xl bg-[#eaf2f6] text-[#7190a1]"><ImageIcon size={20} /></div>}<div className="min-w-0 flex-1"><p className="truncate text-[10px] font-extrabold text-[#36576c]">{record.filename}</p><p className="mt-1 text-[9px] text-[#8198a6]">{record.sampleType} · {record.site}</p><span className="mt-1.5 inline-flex rounded-full px-2 py-0.5 text-[9px] font-extrabold text-white" style={{ background: gradeColors[record.grade] }}>{gradeLabels[record.grade]}</span></div><button data-testid={`button-delete-record-${record.id}`} onClick={() => onDelete(record.id)} className="focus-ring rounded-lg p-2 text-[#a6b6bf] hover:bg-[#fff0ed] hover:text-[#c86e66]" aria-label={`Delete ${record.filename}`}><Trash2 size={15} /></button></div>)}</div> : <div className="flex min-h-[300px] flex-col items-center justify-center text-center"><div className="mb-3 rounded-2xl bg-[#e9f5f9] p-4 text-[#4ca3c5]"><Archive size={28} /></div><h3 className="text-[14px] font-extrabold text-[#466377]">Nothing captured yet</h3><p className="mt-1 max-w-[230px] text-[11px] leading-4 text-[#839aa8]">Completed samples will appear here for a quick quality check.</p></div>}</div><div className="flex items-center justify-between border-t border-[#e1edf2] bg-[#f0f6f9] px-5 py-3"><span className="text-[10px] text-[#8197a5]">Delete removes the local record and rolls back the tally.</span><div className="flex gap-2"><button data-testid="button-export-json-review" onClick={() => onExport('json')} className="focus-ring flex items-center gap-1.5 rounded-lg border border-[#d1e1e8] bg-white px-3 py-2 text-[10px] font-bold text-[#527084]"><Download size={13} /> JSON</button><button data-testid="button-done-review" onClick={onClose} className="focus-ring rounded-lg bg-[#214e69] px-4 py-2 text-[10px] font-extrabold text-white">Done</button></div></div></div></div>;
}
function EndModal({ records, settings, onClose, onExport }: { records: RecordItem[]; settings: SessionSettings; onClose: () => void; onExport: (format: 'csv' | 'json') => void }) {
  return <div className="fixed inset-0 z-30 flex items-center justify-center bg-[#18354a]/40 p-4 backdrop-blur-sm"><div className="modal-in w-full max-w-[530px] overflow-hidden rounded-[24px] border border-white/70 bg-[#f9fcfd] shadow-[0_25px_80px_rgba(20,58,86,.24)]"><div className="blue-sheen p-6 text-white"><div className="flex items-start justify-between"><div><p className="text-[10px] font-bold uppercase tracking-[.14em] text-white/70">Session wrap</p><h2 className="mt-2 text-[25px] font-extrabold tracking-[-.05em]">Secure the day’s work.</h2><p className="mt-1 text-[11px] text-white/75">Your records stay on this device until you export or remove them.</p></div><Archive size={27} className="text-white/80" /></div></div><div className="space-y-4 p-6"><div className="grid grid-cols-3 gap-2">{[['Samples', records.length], ['Operator', settings.operator || '—'], ['Grader', settings.grader || '—']].map(([label, value]) => <div key={String(label)} className="rounded-xl bg-[#eef6f9] p-3"><p className="eyebrow">{label}</p><p className="mt-1 truncate text-[12px] font-extrabold text-[#38566a]">{value}</p></div>)}</div><div className="flex gap-3 rounded-[15px] border border-[#f0d9c8] bg-[#fff8f2] p-3.5"><Upload size={17} className="mt-0.5 shrink-0 text-[#d08362]" /><div><p className="text-[11px] font-extrabold text-[#805846]">Backup reminder</p><p className="mt-1 text-[10px] leading-4 text-[#9e7662]">Copy today’s folder to a USB drive or backup disk before leaving the landing center.</p></div></div><div className="flex gap-2"><button data-testid="button-export-csv-end" onClick={() => onExport('csv')} className="focus-ring flex flex-1 items-center justify-center gap-2 rounded-xl border border-[#cfe1e9] bg-white py-3 text-[11px] font-extrabold text-[#4f7185]"><Download size={15} /> Export CSV</button><button data-testid="button-export-json-end" onClick={() => onExport('json')} className="focus-ring flex flex-1 items-center justify-center gap-2 rounded-xl border border-[#cfe1e9] bg-white py-3 text-[11px] font-extrabold text-[#4f7185]"><Download size={15} /> Export JSON</button></div><button data-testid="button-close-end" onClick={onClose} className="focus-ring w-full rounded-xl bg-[#214e69] py-3 text-[11px] font-extrabold text-white">Continue session</button></div></div></div>;
}
function ToolsModal({ settings, onClose, onInstall }: { settings: SessionSettings; onClose: () => void; onInstall?: () => Promise<void> }) {
  return <div className="fixed inset-0 z-30 flex items-center justify-center bg-[#18354a]/40 p-4 backdrop-blur-sm"><div className="modal-in w-full max-w-[460px] rounded-[24px] border border-white/70 bg-[#f9fcfd] p-6 shadow-[0_25px_80px_rgba(20,58,86,.24)]"><div className="flex items-start justify-between"><div><p className="eyebrow">Session tools</p><h2 className="mt-1 text-[19px] font-extrabold text-[#203e54]">Field instrument</h2></div><button data-testid="button-close-tools" onClick={onClose} className="focus-ring rounded-lg p-2 text-[#78919f] hover:bg-white"><X size={18} /></button></div><div className="mt-5 space-y-2"><ToolRow icon={<CloudOff size={16} />} title="Offline-first storage" detail="All captures and metadata remain in this browser." /><ToolRow icon={<ShieldCheck size={16} />} title="No cloud sync" detail="TUNCAM never sends field data to a server." /><ToolRow icon={<FolderOpen size={16} />} title="Folder access" detail={settings.storage} /></div>{onInstall && <button data-testid="button-install-tools" onClick={onInstall} className="focus-ring mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-[#e7f6fb] py-3 text-[11px] font-extrabold text-[#257d9f]"><Download size={15} /> Install TUNCAM on this device</button>}<button data-testid="button-done-tools" onClick={onClose} className="focus-ring mt-2 w-full rounded-xl bg-[#214e69] py-3 text-[11px] font-extrabold text-white">Done</button></div></div>;
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