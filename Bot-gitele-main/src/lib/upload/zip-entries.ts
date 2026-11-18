import { inflateRawSync } from "node:zlib";
import { UserFacingError } from "../github/client";
export interface ZipEntryInfo {
  name: string;
  isSymlink: boolean;
  isDirectory: boolean;
  mode?: "100644" | "100755";
  crc: number;
  size: number;
  compressedSize: number;
  dataOffset: number;
  method: number;
}
const CP437 =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function decodeName(bytes: Uint8Array, utf8: boolean): string {
  if (utf8) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new UserFacingError("Invalid UTF-8 ZIP filename");
    }
  }
  return Array.from(bytes, (b) =>
    b < 128 ? String.fromCharCode(b) : CP437[b - 128],
  ).join("");
}
function bad(): never {
  throw new UserFacingError(
    "The ZIP central directory or local header is corrupted.",
  );
}
/** Standard single-disk ZIP only; validates central/local correspondence before inflation. */
export function readCentralDirectory(archive: Uint8Array): ZipEntryInfo[] {
  const v = new DataView(
    archive.buffer,
    archive.byteOffset,
    archive.byteLength,
  );
  let end = -1;
  for (
    let i = archive.length - 22;
    i >= Math.max(0, archive.length - 22 - 65535);
    i--
  ) {
    if (
      v.getUint32(i, true) === 0x06054b50 &&
      i + 22 + v.getUint16(i + 20, true) === archive.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0)
    throw new UserFacingError("The file is not a valid ZIP archive.");
  const count = v.getUint16(end + 10, true),
    cdSize = v.getUint32(end + 12, true),
    cd = v.getUint32(end + 16, true);
  if (count === 65535 || cd === 0xffffffff || cdSize === 0xffffffff)
    throw new UserFacingError(
      "ZIP64 archives are not supported. Re-zip as a standard ZIP.",
    );
  if (
    v.getUint16(end + 4, true) !== 0 ||
    v.getUint16(end + 6, true) !== 0 ||
    v.getUint16(end + 8, true) !== count ||
    cd + cdSize !== end
  )
    bad();
  const entries: ZipEntryInfo[] = [],
    names = new Set<string>(),
    ranges: { start: number; end: number }[] = [];
  let pos = cd;
  for (let n = 0; n < count; n++) {
    if (pos + 46 > end || v.getUint32(pos, true) !== 0x02014b50) bad();
    const flags = v.getUint16(pos + 8, true),
      method = v.getUint16(pos + 10, true),
      crc = v.getUint32(pos + 16, true),
      compressed = v.getUint32(pos + 20, true),
      size = v.getUint32(pos + 24, true);
    const nameLen = v.getUint16(pos + 28, true),
      extraLen = v.getUint16(pos + 30, true),
      commentLen = v.getUint16(pos + 32, true),
      local = v.getUint32(pos + 42, true);
    if (
      size === 0xffffffff ||
      compressed === 0xffffffff ||
      local === 0xffffffff
    )
      throw new UserFacingError("ZIP64 archives are not supported.");
    if (flags & 1 || flags & 64)
      throw new UserFacingError("Encrypted ZIP archives are not supported.");
    if (method !== 0 && method !== 8)
      throw new UserFacingError(
        "Unsupported ZIP compression method. Use store or deflate.",
      );
    if (
      v.getUint16(pos + 34, true) !== 0 ||
      pos + 46 + nameLen + extraLen + commentLen > end
    )
      bad();
    const rawName = archive.subarray(pos + 46, pos + 46 + nameLen);
    let name = decodeName(rawName, Boolean(flags & 2048));
    for (let e = pos + 46 + nameLen; e < pos + 46 + nameLen + extraLen; ) {
      if (e + 4 > pos + 46 + nameLen + extraLen) bad();
      const id = v.getUint16(e, true),
        length = v.getUint16(e + 2, true);
      e += 4;
      if (e + length > pos + 46 + nameLen + extraLen) bad();
      if (
        id === 0x7075 &&
        length >= 5 &&
        archive[e] === 1 &&
        v.getUint32(e + 1, true) === crc32(rawName)
      )
        name = decodeName(archive.subarray(e + 5, e + length), true);
      e += length;
    }
    if (names.has(name))
      throw new UserFacingError("Duplicate ZIP entry: " + name.slice(0, 100));
    names.add(name);
    if (
      local + 30 > cd ||
      v.getUint32(local, true) !== 0x04034b50 ||
      v.getUint16(local + 6, true) !== flags ||
      v.getUint16(local + 8, true) !== method
    )
      bad();
    const ln = v.getUint16(local + 26, true),
      le = v.getUint16(local + 28, true),
      dataOffset = local + 30 + ln + le;
    if (ln !== nameLen || dataOffset + compressed > cd) bad();
    const localName = archive.subarray(local + 30, local + 30 + ln);
    if (localName.some((b, i) => b !== rawName[i])) bad();
    if (
      !(flags & 8) &&
      (v.getUint32(local + 14, true) !== crc ||
        v.getUint32(local + 18, true) !== compressed ||
        v.getUint32(local + 22, true) !== size)
    )
      bad();
    const unixMode = v.getUint32(pos + 38, true) >>> 16,
      type = unixMode & 0xf000;
    if (type && ![0x8000, 0x4000, 0xa000].includes(type))
      throw new UserFacingError(
        "Unsupported special file in ZIP: " + name.slice(0, 100),
      );
    const directory = name.endsWith("/");
    if (type === 0x4000 && !directory) bad();
    if (directory && size !== 0)
      throw new UserFacingError("A ZIP directory contains file data");
    entries.push({
      name,
      isSymlink: type === 0xa000,
      isDirectory: directory,
      ...(type === 0x8000
        ? {
            mode: (unixMode & 0o111 ? "100755" : "100644") as
              | "100644"
              | "100755",
          }
        : {}),
      crc,
      size,
      compressedSize: compressed,
      dataOffset,
      method,
    });
    ranges.push({ start: local, end: dataOffset + compressed });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  if (pos !== cd + cdSize) bad();
  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++)
    if (ranges[i].start < ranges[i - 1].end) bad();
  return entries;
}
export function assertNoSymlinks(archive: Uint8Array): void {
  const links = readCentralDirectory(archive).filter((e) => e.isSymlink);
  if (links.length)
    throw new UserFacingError(
      "Symbolic links are not supported: " + links[0].name.slice(0, 100),
    );
}

/** Inflate exactly one validated entry with a hard output cap and CRC check. */
export function inflateZipEntry(
  archive: Uint8Array,
  entry: ZipEntryInfo,
  maxBytes: number,
): Uint8Array {
  if (entry.isDirectory || entry.isSymlink || entry.size > maxBytes)
    throw new UserFacingError(
      "ZIP entry is not a supported regular file or is too large.",
    );
  const input = archive.subarray(
    entry.dataOffset,
    entry.dataOffset + entry.compressedSize,
  );
  let bytes: Uint8Array;
  try {
    const data =
      entry.method === 0
        ? input.slice()
        : inflateRawSync(input, { maxOutputLength: Math.max(1, entry.size) });
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } catch {
    throw new UserFacingError(
      "ZIP decompression failed or exceeded its declared size: " + entry.name,
    );
  }
  if (bytes.length !== entry.size || crc32(bytes) !== entry.crc)
    throw new UserFacingError(
      "ZIP file size or CRC checksum mismatch: " + entry.name,
    );
  return bytes;
}
