export async function pickSessionFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (typeof window.showDirectoryPicker !== 'function') return null;

  // First attempt: try with relaxed options (no startIn to avoid "system files" error)
  try {
    return await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (error) {
    // If user cancelled, propagate AbortError so caller can show "cancelled" message
    if (error instanceof DOMException && error.name === 'AbortError') throw error;

    // Second attempt: completely bare call as last fallback
    try {
      return await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (retryError) {
      if (retryError instanceof DOMException && retryError.name === 'AbortError') throw retryError;
      throw new FolderAccessError(
        'Could not open the selected folder. Try choosing a different folder that is not a system directory.',
        retryError,
      );
    }
  }
}

export class FolderAccessError extends Error {
  cause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'FolderAccessError';
    this.cause = cause;
  }
}

export async function ensureFolderPermission(handle: FileSystemDirectoryHandle) {
  try {
    const current = await handle.queryPermission({ mode: 'readwrite' });
    if (current === 'granted') return true;
    const next = await handle.requestPermission({ mode: 'readwrite' });
    return next === 'granted';
  } catch {
    return false;
  }
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
