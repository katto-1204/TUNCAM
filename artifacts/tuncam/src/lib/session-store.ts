import { dataUrlToBlob, type RecordItem } from './dataset';

const DB_NAME = 'tuncam-capture-db';
const DB_VERSION = 1;
const RECORDS_STORE = 'records';
const IMAGES_STORE = 'images';
const HANDLES_STORE = 'handles';
const LEGACY_KEY = 'tuncam-capture-records-v1';
const HANDLE_KEY = 'session-root';

type LegacyRecord = RecordItem & { image?: string };

function openDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECORDS_STORE)) db.createObjectStore(RECORDS_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(IMAGES_STORE)) db.createObjectStore(IMAGES_STORE);
      if (!db.objectStoreNames.contains(HANDLES_STORE)) db.createObjectStore(HANDLES_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB failed to open.'));
  });
}

function completeTransaction<T>(tx: IDBTransaction, result: () => T) {
  return new Promise<T>((resolve, reject) => {
    tx.oncomplete = () => resolve(result());
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

export async function listRecords() {
  const db = await openDb();
  try {
    const tx = db.transaction(RECORDS_STORE, 'readonly');
    const request = tx.objectStore(RECORDS_STORE).getAll() as IDBRequest<RecordItem[]>;
    return await completeTransaction(tx, () => request.result ?? []);
  } finally {
    db.close();
  }
}

export async function putRecord(record: RecordItem, image: Blob) {
  const db = await openDb();
  try {
    const tx = db.transaction([RECORDS_STORE, IMAGES_STORE], 'readwrite');
    tx.objectStore(RECORDS_STORE).put(record);
    tx.objectStore(IMAGES_STORE).put(image, record.id);
    await completeTransaction(tx, () => undefined);
  } finally {
    db.close();
  }
}

/** Update record metadata (e.g. a grade override) without touching the stored image. */
export async function updateRecord(record: RecordItem) {
  const db = await openDb();
  try {
    const tx = db.transaction(RECORDS_STORE, 'readwrite');
    tx.objectStore(RECORDS_STORE).put(record);
    await completeTransaction(tx, () => undefined);
  } finally {
    db.close();
  }
}

export async function removeRecord(id: string) {
  const db = await openDb();
  try {
    const tx = db.transaction([RECORDS_STORE, IMAGES_STORE], 'readwrite');
    tx.objectStore(RECORDS_STORE).delete(id);
    tx.objectStore(IMAGES_STORE).delete(id);
    await completeTransaction(tx, () => undefined);
  } finally {
    db.close();
  }
}

export async function clearSession() {
  const db = await openDb();
  try {
    const tx = db.transaction([RECORDS_STORE, IMAGES_STORE], 'readwrite');
    tx.objectStore(RECORDS_STORE).clear();
    tx.objectStore(IMAGES_STORE).clear();
    await completeTransaction(tx, () => undefined);
  } finally {
    db.close();
  }
}

export async function getImage(id: string) {
  const db = await openDb();
  try {
    const tx = db.transaction(IMAGES_STORE, 'readonly');
    const request = tx.objectStore(IMAGES_STORE).get(id) as IDBRequest<Blob | undefined>;
    return await completeTransaction(tx, () => request.result);
  } finally {
    db.close();
  }
}

export async function getAllImages() {
  const db = await openDb();
  try {
    const tx = db.transaction(IMAGES_STORE, 'readonly');
    const store = tx.objectStore(IMAGES_STORE);
    const keysRequest = store.getAllKeys() as IDBRequest<IDBValidKey[]>;
    const valuesRequest = store.getAll() as IDBRequest<Blob[]>;
    return await completeTransaction(tx, () => {
      const images = new Map<string, Blob>();
      (keysRequest.result ?? []).forEach((key, index) => {
        images.set(String(key), valuesRequest.result[index]);
      });
      return images;
    });
  } finally {
    db.close();
  }
}

export async function saveDirectoryHandle(handle: FileSystemDirectoryHandle) {
  const db = await openDb();
  try {
    const tx = db.transaction(HANDLES_STORE, 'readwrite');
    tx.objectStore(HANDLES_STORE).put(handle, HANDLE_KEY);
    await completeTransaction(tx, () => undefined);
  } finally {
    db.close();
  }
}

export async function loadDirectoryHandle() {
  const db = await openDb();
  try {
    const tx = db.transaction(HANDLES_STORE, 'readonly');
    const request = tx.objectStore(HANDLES_STORE).get(HANDLE_KEY) as IDBRequest<FileSystemDirectoryHandle | undefined>;
    return await completeTransaction(tx, () => request.result ?? null);
  } finally {
    db.close();
  }
}

export async function migrateLegacyRecords() {
  let raw = '';
  try {
    raw = localStorage.getItem(LEGACY_KEY) || '';
  } catch {
    return [];
  }
  if (!raw) return [];

  let parsed: LegacyRecord[] = [];
  try {
    parsed = JSON.parse(raw) as LegacyRecord[];
  } catch {
    return [];
  }
  if (!Array.isArray(parsed) || !parsed.length) return [];

  const existing = await listRecords();
  if (existing.length) {
    try { localStorage.removeItem(LEGACY_KEY); } catch { /* ignore */ }
    return existing;
  }

  for (const item of parsed) {
    const { image, ...record } = item;
    if (!record.id || !record.filename) continue;
    const blob = image?.startsWith('data:') ? dataUrlToBlob(image) : new Blob([], { type: 'image/jpeg' });
    await putRecord(record, blob);
  }

  try { localStorage.removeItem(LEGACY_KEY); } catch { /* ignore */ }
  return listRecords();
}
