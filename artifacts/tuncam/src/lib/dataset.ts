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

/* ═══════════════════════════════════════════════════════════════════════════
   SHORT SITE CODES
   ═══════════════════════════════════════════════════════════════════════════ */

const SITE_CODE_MAP: Record<string, string> = {
  'Bangkerohan, General Santos City': 'BNK',
  'Fish Port, General Santos City': 'GENS',
  'Navotas Fish Port, Metro Manila': 'NAV',
};

/** Get a short uppercase site code (3-4 chars) */
export function siteCode(site: string): string {
  // Check known sites first
  const known = SITE_CODE_MAP[site];
  if (known) return known;
  // For custom sites: take first word, uppercase, max 4 chars
  const word = site.replace(/[^a-zA-Z0-9\s]/g, '').trim().split(/\s+/)[0] || 'SITE';
  return word.slice(0, 4).toUpperCase();
}

/** Full slug for folder names (keeps the long version for folder paths) */
export function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 34) || 'site';
}

/* ═══════════════════════════════════════════════════════════════════════════
   DATE HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

/** Full date YYYY-MM-DD (for folders) */
export function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Short date YY-MM-DD (for filenames) */
export function shortDate(date = today()) {
  // "2026-08-24" → "26-08-24"
  return date.slice(2);
}

/* ═══════════════════════════════════════════════════════════════════════════
   SAMPLE & GRADE HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

export function sampleCode(type: SampleType) {
  return type === 'Sashibo Core' ? 'SC' : 'TC';
}

export function sampleFolder(type: SampleType) {
  return type === 'Sashibo Core' ? 'Sashibo-Core' : 'Tail-Cut';
}

/** Grade code for filenames: GRD_A, GRD_B, GRD_C, GRD_INV */
export function gradeCode(grade: Grade) {
  if (grade === 'Invalid') return 'GRD_INV';
  return `GRD_${grade}`;
}

export function gradeFolder(grade: Grade) {
  return grade === 'Invalid' ? 'Invalid' : `Grade${grade}`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   FOLDER STRUCTURE
   Keeps the full structure the user wanted:
   tuncam/
     2026-08-18-bangkerohan-general-santos-city/
       Sashibo-Core/
         GradeA/
   ═══════════════════════════════════════════════════════════════════════════ */

export const exportRoot = 'tuncam';

export function sessionFolder(site: string, date = today()) {
  return `${date}-${slug(site)}`;
}

export function recordFolder(record: Pick<RecordItem, 'date' | 'site' | 'sampleType' | 'grade'>) {
  return `${exportRoot}/${sessionFolder(record.site, record.date)}/${sampleFolder(record.sampleType)}/${gradeFolder(record.grade)}`;
}

export function recordPath(record: RecordItem) {
  return `${recordFolder(record)}/${jpegFilename(record)}`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   FILENAME FORMAT (SHORT)
   Format: YY-MM-DD-SITE-SC-GRD_A-001.jpg
   Example: 26-08-24-BNK-SC-GRD_A-001.jpg
   ═══════════════════════════════════════════════════════════════════════════ */

export function buildFilename(site: string, sampleType: SampleType, grade: Grade, sequence: number, date = today()) {
  return `${shortDate(date)}-${siteCode(site)}-${sampleCode(sampleType)}-${gradeCode(grade)}-${String(sequence).padStart(3, '0')}.jpg`;
}

export function jpegFilename(record: Pick<RecordItem, 'date' | 'site' | 'sampleType' | 'grade' | 'sequence'>) {
  return buildFilename(record.site, record.sampleType, record.grade, record.sequence, record.date);
}

export function photoZipPath(record: RecordItem) {
  return recordPath(record);
}

export function exampleFilename(site: string, date = today()) {
  return buildFilename(site || 'Bangkerohan, General Santos City', 'Sashibo Core', 'A', 1, date);
}

export function exampleFolder(site: string, date = today()) {
  return `${exportRoot}/${sessionFolder(site, date)}/Sashibo-Core/GradeA`;
}

export function datasetZipName(site: string, date = today()) {
  return `TUNCAM-${shortDate(date)}-${siteCode(site)}.zip`;
}

export function exportGuideText(site: string, sampleName: string, date = today()) {
  const session = sessionFolder(site, date);
  return [
    'TUNCAM session export',
    '',
    'After Extract All, open this folder tree:',
    '',
    `  ${exportRoot}/`,
    `    ${session}/`,
    '      Sashibo-Core/',
    '        GradeA/',
    '        GradeB/',
    '        GradeC/',
    '        Invalid/',
    '      Tail-Cut/',
    '        GradeA/',
    '        GradeB/',
    '        GradeC/',
    '        Invalid/',
    '',
    'Each photo lives inside the matching sample type and grade folder.',
    '',
    'Filename format: YY-MM-DD-SITECODE-SC/TC-GRD_X-SEQ.jpg',
    `Example: ${sampleName}`,
    '',
    'Site codes:',
    '  BNK  = Bangkerohan, General Santos City',
    '  GENS = Fish Port, General Santos City',
    '  NAV  = Navotas Fish Port, Metro Manila',
    '',
    'Sample codes: SC = Sashibo Core, TC = Tail-Cut',
    'Grade codes:  GRD_A, GRD_B, GRD_C, GRD_INV (Invalid)',
    '',
    'How to open on Windows:',
    '1. Right-click the ZIP > Extract All.',
    `2. Open ${exportRoot} > ${session} > Sashibo-Core or Tail-Cut > GradeA (or B / C / Invalid).`,
    '3. Double-click a JPG file to view it.',
    '',
    'Windows may hide the .jpg extension. The Type column should still say JPG File.',
    'session-manifest.csv is a spreadsheet of capture details, not a photo.',
  ].join('\n');
}

/* ═══════════════════════════════════════════════════════════════════════════
   MANIFEST EXPORT
   ═══════════════════════════════════════════════════════════════════════════ */

export function buildManifestRows(records: RecordItem[], settings: SessionSettings) {
  return records.map((record) => ({
    filename: jpegFilename(record),
    date: record.date,
    site: record.site,
    site_code: siteCode(record.site),
    sample_type: record.sampleType,
    sample_code: sampleCode(record.sampleType),
    grade: record.grade,
    grade_code: gradeCode(record.grade),
    sequence: record.sequence,
    operator: settings.operator,
    grader: settings.grader,
    folder: recordFolder(record),
    created_at: record.createdAt,
  }));
}

export function manifestCsv(records: RecordItem[], settings: SessionSettings) {
  const rows = buildManifestRows(records, settings);
  const header = 'filename,date,site,site_code,sample_type,sample_code,grade,grade_code,sequence,operator,grader,folder,created_at';
  const body = rows.map((row) =>
    [row.filename, row.date, row.site, row.site_code, row.sample_type, row.sample_code, row.grade, row.grade_code, row.sequence, row.operator, row.grader, row.folder, row.created_at]
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
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  const keepMs = Math.min(10 * 60_000, Math.max(120_000, Math.ceil(blob.size / 8)));
  window.setTimeout(() => URL.revokeObjectURL(url), keepMs);
}
