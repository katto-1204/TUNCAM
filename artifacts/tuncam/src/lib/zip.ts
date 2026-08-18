function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc ^= data[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: day };
}

function u16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true);
}

function u32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value, true);
}

async function toBytes(data: Blob | Uint8Array | string) {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    return copy;
  }
  return new Uint8Array(await data.arrayBuffer());
}

function toBlobPart(data: Uint8Array): BlobPart {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

function zipSafeName(name: string) {
  return name
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')
    .replace(/[^\x20-\x7E]/g, '-')
    .replace(/\/{2,}/g, '/');
}

function nameFlags(nameBytes: Uint8Array) {
  return nameBytes.every((byte) => byte < 128) ? 0 : 0x0800;
}

export type ZipEntry = {
  name: string;
  data: Blob | Uint8Array | string;
};

export async function buildZip(entries: ZipEntry[]) {
  const parts: BlobPart[] = [];
  const centralParts: Uint8Array[] = [];
  const stamp = dosDateTime();
  let offset = 0;

  for (const entry of entries) {
    const name = zipSafeName(entry.name);
    const nameBytes = new TextEncoder().encode(name);
    const flags = nameFlags(nameBytes);
    const payload = await toBytes(entry.data);
    const crc = crc32(payload);

    const local = new Uint8Array(30);
    const localView = new DataView(local.buffer);
    u32(localView, 0, 0x04034b50);
    u16(localView, 4, 20);
    u16(localView, 6, flags);
    u16(localView, 8, 0);
    u16(localView, 10, stamp.time);
    u16(localView, 12, stamp.date);
    u32(localView, 14, crc);
    u32(localView, 18, payload.length);
    u32(localView, 22, payload.length);
    u16(localView, 26, nameBytes.length);
    u16(localView, 28, 0);

    const central = new Uint8Array(46);
    const centralView = new DataView(central.buffer);
    u32(centralView, 0, 0x02014b50);
    u16(centralView, 4, 20);
    u16(centralView, 6, 20);
    u16(centralView, 8, flags);
    u16(centralView, 10, 0);
    u16(centralView, 12, stamp.time);
    u16(centralView, 14, stamp.date);
    u32(centralView, 16, crc);
    u32(centralView, 20, payload.length);
    u32(centralView, 24, payload.length);
    u16(centralView, 26, nameBytes.length);
    u16(centralView, 28, 0);
    u16(centralView, 30, 0);
    u16(centralView, 32, 0);
    u16(centralView, 34, 0);
    u32(centralView, 36, 0);
    u32(centralView, 38, offset);

    parts.push(toBlobPart(local), toBlobPart(nameBytes), toBlobPart(payload));
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + payload.length;
  }

  const centralStart = offset;
  for (const part of centralParts) {
    parts.push(toBlobPart(part));
    offset += part.length;
  }

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  u32(eocdView, 0, 0x06054b50);
  u16(eocdView, 4, 0);
  u16(eocdView, 6, 0);
  u16(eocdView, 8, entries.length);
  u16(eocdView, 10, entries.length);
  u32(eocdView, 12, offset - centralStart);
  u32(eocdView, 16, centralStart);
  u16(eocdView, 20, 0);
  parts.push(eocd);

  return new Blob(parts, { type: 'application/zip' });
}
