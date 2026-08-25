/* Minimal ZIP reader for TUNCAM session exports.
   Supports stored (method 0) and deflate (method 8) entries. */

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('This browser cannot decompress ZIP entries. Use the original TUNCAM export ZIP.');
  }
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function mimeFor(name: string) {
  if (/\.jpe?g$/i.test(name)) return 'image/jpeg';
  if (/\.json$/i.test(name)) return 'application/json';
  if (/\.csv$/i.test(name)) return 'text/csv';
  if (/\.txt$/i.test(name)) return 'text/plain';
  return 'application/octet-stream';
}

/** Read every file entry of a ZIP blob into a name -> Blob map. */
export async function readZipFiles(file: Blob): Promise<Map<string, Blob>> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Locate End Of Central Directory record
  let eocd = -1;
  const scanFloor = Math.max(0, bytes.byteLength - 22 - 65_536);
  for (let i = bytes.byteLength - 22; i >= scanFloor; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('That file is not a valid ZIP archive.');

  const count = view.getUint16(eocd + 10, true);
  let ptr = view.getUint32(eocd + 16, true);
  if (ptr + count * 46 > bytes.byteLength) throw new Error('That ZIP archive is corrupted.');

  const files = new Map<string, Blob>();
  const decoder = new TextDecoder();

  for (let i = 0; i < count; i += 1) {
    if (ptr + 46 > bytes.byteLength || view.getUint32(ptr, true) !== 0x02014b50) break;
    const method = view.getUint16(ptr + 10, true);
    const compSize = view.getUint32(ptr + 20, true);
    const uncompSize = view.getUint32(ptr + 24, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localOffset = view.getUint32(ptr + 42, true);
    const name = decoder.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    ptr += 46 + nameLen + extraLen + commentLen;

    if (!uncompSize || !nameLen) continue; // directory or empty entry
    if (localOffset + 30 > bytes.byteLength || view.getUint32(localOffset, true) !== 0x04034b50) continue;
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compSize > bytes.byteLength) continue;

    let data: Uint8Array | undefined;
    try {
      if (method === 0) {
        data = bytes.subarray(dataStart, dataStart + compSize);
      } else if (method === 8) {
        data = await inflateRaw(bytes.subarray(dataStart, dataStart + compSize));
      }
    } catch {
      continue;
    }
    if (!data || !data.length) continue;
    const exactCopy = new Uint8Array(data);
    files.set(name.replaceAll('\\', '/'), new Blob([exactCopy.buffer as ArrayBuffer], { type: mimeFor(name) }));
  }

  return files;
}
