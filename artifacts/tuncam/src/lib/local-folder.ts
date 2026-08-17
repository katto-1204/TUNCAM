export async function pickSessionFolder() {
  if (typeof window.showDirectoryPicker !== 'function') return null;
  return window.showDirectoryPicker({ id: 'tuncam-session', mode: 'readwrite', startIn: 'documents' });
}

export async function ensureFolderPermission(handle: FileSystemDirectoryHandle) {
  const current = await handle.queryPermission({ mode: 'readwrite' });
  if (current === 'granted') return true;
  const next = await handle.requestPermission({ mode: 'readwrite' });
  return next === 'granted';
}

export async function writeRelativeFile(root: FileSystemDirectoryHandle, relativePath: string, data: Blob | string) {
  const parts = relativePath.replaceAll('\\', '/').split('/').filter(Boolean);
  const filename = parts.pop();
  if (!filename) throw new Error('Missing filename.');
  let dir = root;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  const file = await dir.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  await writable.write(data);
  await writable.close();
}

export async function deleteRelativeFile(root: FileSystemDirectoryHandle, relativePath: string) {
  const parts = relativePath.replaceAll('\\', '/').split('/').filter(Boolean);
  const filename = parts.pop();
  if (!filename) return;
  let dir = root;
  for (const part of parts) {
    try {
      dir = await dir.getDirectoryHandle(part);
    } catch {
      return;
    }
  }
  try {
    await dir.removeEntry(filename);
  } catch {
    /* already gone */
  }
}
