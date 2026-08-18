function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc ^= data[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(date.getFullYear(), 1980);
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: day };
}

function zipSafeName(name: string) {
  return name
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')
    .replace(/[^\x20-\x7E]/g, '-')
    .replace(/\/{2,}/g, '/')
    .slice(0, 240);
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

export type ZipEntry = {
  name: string;
  data: Blob | Uint8Array | string;
};

type PreparedEntry = {
  nameBytes: Uint8Array;
  payload: Uint8Array;
  crc: number;
};

export async function buildZip(entries: ZipEntry[]) {
  const stamp = dosDateTime();
  const files: PreparedEntry[] = [];

  for (const entry of entries) {
    const name = zipSafeName(entry.name);
    if (!name) continue;
    const nameBytes = new TextEncoder().encode(name);
    const payload = await toBytes(entry.data);
    files.push({ nameBytes, payload, crc: crc32(payload) });
  }

  let size = 22;
  for (const file of files) {
    size += 30 + file.nameBytes.length + file.payload.length;
    size += 46 + file.nameBytes.length;
  }

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let offset = 0;
  const localOffsets: number[] = [];

  const writeU16 = (value: number) => {
    view.setUint16(offset, value, true);
    offset += 2;
  };
  const writeU32 = (value: number) => {
    view.setUint32(offset, value, true);
    offset += 4;
  };
  const writeBytes = (bytes: Uint8Array) => {
    out.set(bytes, offset);
    offset += bytes.length;
  };

  for (const file of files) {
    localOffsets.push(offset);
    writeU32(0x04034b50);
    writeU16(10);
    writeU16(0);
    writeU16(0);
    writeU16(stamp.time);
    writeU16(stamp.date);
    writeU32(file.crc);
    writeU32(file.payload.length);
    writeU32(file.payload.length);
    writeU16(file.nameBytes.length);
    writeU16(0);
    writeBytes(file.nameBytes);
    writeBytes(file.payload);
  }

  const centralStart = offset;
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    writeU32(0x02014b50);
    writeU16(20);
    writeU16(10);
    writeU16(0);
    writeU16(0);
    writeU16(stamp.time);
    writeU16(stamp.date);
    writeU32(file.crc);
    writeU32(file.payload.length);
    writeU32(file.payload.length);
    writeU16(file.nameBytes.length);
    writeU16(0);
    writeU16(0);
    writeU16(0);
    writeU16(0);
    writeU32(0x20);
    writeU32(localOffsets[i]);
    writeBytes(file.nameBytes);
  }

  const centralSize = offset - centralStart;
  writeU32(0x06054b50);
  writeU16(0);
  writeU16(0);
  writeU16(files.length);
  writeU16(files.length);
  writeU32(centralSize);
  writeU32(centralStart);
  writeU16(0);

  if (offset !== out.length) {
    throw new Error(`ZIP size mismatch: wrote ${offset}, expected ${out.length}`);
  }

  return new Blob([out], { type: 'application/zip' });
}
