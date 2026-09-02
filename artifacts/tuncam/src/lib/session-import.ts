import { buildFilename, grades, jpegFilename, parseCaptureFromFolder, type CaptureMode, type Grade, type RecordItem, type SampleType } from './dataset';
import { getImage, putRecord } from './session-store';
import { readZipFiles } from './zip-read';

export type ImportResult = {
  added: RecordItem[];
  images: Map<string, Blob>;
  duplicates: number;
  missingImages: number;
};

type ManifestRow = {
  filename?: unknown;
  date?: unknown;
  site?: unknown;
  sample_type?: unknown;
  grade?: unknown;
  sequence?: unknown;
  created_at?: unknown;
  folder?: unknown;
  capture_mode?: unknown;
  rotation_side?: unknown;
};

function resolveCaptureFields(row: ManifestRow, folder: string) {
  const fromFolder = folder ? parseCaptureFromFolder(folder) : {};
  const mode = row.capture_mode === 'rotation' ? 'rotation' : row.capture_mode === 'standard' ? 'standard' : fromFolder.captureMode;
  const captureMode: CaptureMode = mode === 'rotation' ? 'rotation' : 'standard';
  const rawSide = row.rotation_side;
  const parsedSide = typeof rawSide === 'number'
    ? rawSide
    : typeof rawSide === 'string' && rawSide.trim()
      ? Number(rawSide)
      : undefined;
  const rotationSide = captureMode === 'rotation'
    ? (parsedSide && parsedSide >= 1 && parsedSide <= 6 ? parsedSide : fromFolder.rotationSide ?? 1)
    : undefined;
  return { captureMode, rotationSide };
}

function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc ^= data[i];
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function sameImage(a: Blob | undefined, b: Blob) {
  if (!a || !a.size || a.size !== b.size) return false;
  const [aBuf, bBuf] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()]);
  return crc32(new Uint8Array(aBuf)) === crc32(new Uint8Array(bBuf));
}

const normalizePath = (value: string) => value.replaceAll('\\', '/').replace(/^\.?\//, '').toLowerCase();

/** Import a TUNCAM session ZIP exported from another device and merge it into local storage. */
export async function importSessionZip(file: File, existing: RecordItem[]): Promise<ImportResult> {
  const files = await readZipFiles(file);
  const manifestEntry = files.get('session-manifest.json');
  if (!manifestEntry) throw new Error('That file is not a TUNCAM session export (session-manifest.json is missing).');

  let rows: ManifestRow[];
  try {
    const manifest = JSON.parse(await manifestEntry.text()) as { records?: ManifestRow[] };
    rows = Array.isArray(manifest.records) ? manifest.records : [];
  } catch {
    throw new Error('The session manifest inside that ZIP could not be read.');
  }

  const byName = new Map<string, Blob>();
  for (const [name, blob] of files) byName.set(normalizePath(name), blob);
  const findImage = (folder: string, filename: string) => {
    if (!filename) return undefined;
    const direct = byName.get(normalizePath(`${folder}/${filename}`));
    if (direct) return direct;
    const suffix = `/${normalizePath(filename)}`;
    for (const [name, blob] of byName) {
      if (name.endsWith(suffix)) return blob;
    }
    return undefined;
  };

  // Existing filename -> id, plus the highest sequence already used per date/site/type/grade bucket.
  const usedFilenames = new Map<string, string>();
  const bucketTop = new Map<string, number>();
  for (const record of existing) {
    usedFilenames.set(jpegFilename(record), record.id);
    const key = `${record.date}|${record.site}|${record.sampleType}|${record.grade}`;
    bucketTop.set(key, Math.max(bucketTop.get(key) ?? 0, record.sequence));
  }

  const added: RecordItem[] = [];
  const images = new Map<string, Blob>();
  let duplicates = 0;
  let missingImages = 0;

  for (const row of rows) {
    const site = typeof row.site === 'string' ? row.site : '';
    const date = typeof row.date === 'string' ? row.date : '';
    const sampleType = row.sample_type as SampleType;
    const grade = row.grade as Grade;
    if (!site || !date || !grades.includes(grade) || (sampleType !== 'Sashibo Core' && sampleType !== 'Tail-Cut')) {
      missingImages += 1;
      continue;
    }

    const wantedFilename = typeof row.filename === 'string' ? row.filename : '';
    const folder = typeof row.folder === 'string' ? row.folder : '';
    const image = findImage(folder, wantedFilename);
    if (!image || !image.size) {
      missingImages += 1;
      continue;
    }

    // Keep original numbering; only re-sequence when another capture already claims the filename.
    const key = `${date}|${site}|${sampleType}|${grade}`;
    let sequence = Number(row.sequence) > 0 ? Number(row.sequence) : 1;
    let filename = buildFilename(site, sampleType, grade, sequence, date);
    let isDuplicate = false;
    while (usedFilenames.has(filename)) {
      const existingBlob = await getImage(usedFilenames.get(filename)!);
      if (await sameImage(existingBlob, image)) { isDuplicate = true; break; }
      sequence = Math.max(sequence + 1, (bucketTop.get(key) ?? 0) + 1);
      bucketTop.set(key, sequence);
      filename = buildFilename(site, sampleType, grade, sequence, date);
    }
    if (isDuplicate) { duplicates += 1; continue; }

    const record: RecordItem = {
      id: `imp-${Date.now()}-${added.length}-${Math.floor(Math.random() * 1e6).toString().padStart(6, '0')}`,
      filename,
      date,
      site,
      sampleType,
      grade,
      sequence,
      createdAt: typeof row.created_at === 'string' ? row.created_at : new Date().toISOString(),
      ...resolveCaptureFields(row, folder),
    };
    await putRecord(record, image);
    usedFilenames.set(filename, record.id);
    bucketTop.set(key, Math.max(bucketTop.get(key) ?? 0, sequence));
    added.push(record);
    images.set(record.id, image);
  }

  return { added, images, duplicates, missingImages };
}
