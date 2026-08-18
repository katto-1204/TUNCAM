export type SampleType = 'Sashibo Core' | 'Tail-Cut';
export type Grade = 'A' | 'B' | 'C' | 'Invalid';

export type RecordItem = {
  id: string;
  filename: string;
  date: string;
  site: string;
  sampleType: SampleType;
  grade: Grade;
  sequence: number;
  createdAt: string;
};

export type SessionSettings = {
  site: string;
  operator: string;
  grader: string;
  storage: string;
  sampleType: SampleType | '';
};

export const grades: Grade[] = ['A', 'B', 'C', 'Invalid'];
export const gradeLabels: Record<Grade, string> = {
  A: 'Grade A',
  B: 'Grade B',
  C: 'Grade C',
  Invalid: 'Invalid',
};
export const gradeColors: Record<Grade, string> = {
  A: '#1594d0',
  B: '#4d72dc',
  C: '#8a6bd5',
  Invalid: '#dc776f',
};

export const defaultSettings: SessionSettings = {
  site: 'Bangkerohan, General Santos City',
  operator: '',
  grader: '',
  storage: 'Browser storage · this device',
  sampleType: '',
};

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 34) || 'site';
}

export function sampleCode(type: SampleType) {
  return type === 'Sashibo Core' ? 'sc' : 'tc';
}

export function sampleFolder(type: SampleType) {
  return type === 'Sashibo Core' ? 'Sashibo-Core' : 'Tail-Cut';
}

export function gradeFolder(grade: Grade) {
  return grade === 'Invalid' ? 'Invalid' : `Grade${grade}`;
}

export function recordFolder(record: Pick<RecordItem, 'date' | 'sampleType' | 'grade'>) {
  return `${record.date}/${sampleFolder(record.sampleType)}/${gradeFolder(record.grade)}`;
}

export function recordPath(record: RecordItem) {
  return `${recordFolder(record)}/${jpegFilename(record)}`;
}

export function buildFilename(site: string, sampleType: SampleType, grade: Grade, sequence: number, date = today()) {
  return `${date}-${slug(site)}-${sampleCode(sampleType)}-${grade}-${String(sequence).padStart(3, '0')}.jpg`;
}

export function jpegFilename(record: Pick<RecordItem, 'date' | 'site' | 'sampleType' | 'grade' | 'sequence'>) {
  return buildFilename(record.site, record.sampleType, record.grade, record.sequence, record.date);
}

export function photoZipPath(record: RecordItem) {
  return `PHOTOS/${jpegFilename(record)}`;
}

export function exampleFilename(site: string, date = today()) {
  return buildFilename(site || 'Bangkerohan, General Santos City', 'Sashibo Core', 'A', 1, date);
}

export function datasetZipName(site: string, date = today()) {
  return `TUNCAM-${date}-${slug(site)}.zip`;
}

export function exportGuideText(sampleName: string) {
  return [
    'TUNCAM photo pack',
    '',
    'Open the PHOTOS folder. Those are the sample images.',
    '',
    'Each photo is named:',
    '  date-site-sampletypecode-grade-sequence.jpg',
    `Example: ${sampleName}`,
    '',
    'How to open on Windows:',
    '1. Right-click the ZIP > Extract All.',
    '2. Open the extracted folder, then open PHOTOS.',
    '3. Double-click a JPG file to view it.',
    '',
    'Windows may hide the .jpg extension. The Type column should still say JPG File.',
    'session-manifest.csv is a spreadsheet of capture details, not a photo.',
    '',
    'Codes: sc = Sashibo Core, tc = Tail-Cut. Grade is A, B, C, or Invalid.',
  ].join('\n');
}

export function buildManifestRows(records: RecordItem[], settings: SessionSettings) {
  return records.map((record) => ({
    filename: jpegFilename(record),
    date: record.date,
    site: record.site,
    sample_type: record.sampleType,
    grade: record.grade,
    sequence: record.sequence,
    operator: settings.operator,
    grader: settings.grader,
    folder: recordFolder(record),
    created_at: record.createdAt,
  }));
}

export function manifestCsv(records: RecordItem[], settings: SessionSettings) {
  const rows = buildManifestRows(records, settings);
  const header = 'filename,date,site,sample_type,grade,sequence,operator,grader,folder,created_at';
  const body = rows.map((row) =>
    [row.filename, row.date, row.site, row.sample_type, row.grade, row.sequence, row.operator, row.grader, row.folder, row.created_at]
      .map((value) => `"${String(value).replaceAll('"', '""')}"`)
      .join(','),
  );
  return [header, ...body].join('\n');
}

export function manifestJson(records: RecordItem[], settings: SessionSettings) {
  return JSON.stringify(
    {
      session: { ...settings, date: today(), exportedAt: new Date().toISOString(), total: records.length },
      records: buildManifestRows(records, settings),
    },
    null,
    2,
  );
}

export function dataUrlToBlob(dataUrl: string) {
  const [header, data] = dataUrl.split(',');
  const mime = header.match(/:(.*?);/)?.[1] || 'image/jpeg';
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function triggerDownload(blob: Blob, filename: string) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1500);
}
