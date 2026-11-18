/**
 * Browser-side packaging: anything the user picks (a ZIP, loose files, a whole folder) becomes ONE ZIP,
 * so the existing chunked upload / verify / commit pipeline stays exactly as it is.
 */
import { unzipSync, zipSync } from "fflate";

export interface PickedItem {
  file: File;
  /** Path inside the archive, forward slashes, no leading slash. */
  path: string;
}

const FIXED_TIME = new Date(2000, 0, 1); // deterministic bytes, so resume keys stay stable
const JUNK = /(^|\/)(__MACOSX|\.DS_Store)(\/|$)/;

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Removes ONE shared outer folder (the folder that wraps everything). Returns the input when there is none. */
export function stripOuterFolder<T extends { path: string }>(items: T[]): T[] {
  const real = items.filter((i) => !JUNK.test(i.path));
  if (real.length === 0) return items;
  const first = real[0]!.path.split("/")[0]!;
  const wrapped = real.every((i) => i.path.includes("/") && i.path.split("/")[0] === first);
  if (!wrapped) return items;
  return real.map((i) => ({ ...i, path: i.path.slice(first.length + 1) })).filter((i) => i.path.length > 0);
}

export function baseName(name: string): string {
  return name.replace(/\.[^./\\]+$/, "") || name;
}

async function readZip(file: File): Promise<{ path: string; data: Uint8Array }[] | null> {
  try {
    const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
    return Object.entries(entries)
      .filter(([p]) => !p.endsWith("/"))
      .map(([path, data]) => ({ path, data }));
  } catch {
    return null; // not a readable ZIP: caller keeps the original file
  }
}

/**
 * Turns a pick into one ZIP File.
 * - one .zip and strip off -> returned untouched (byte for byte)
 * - one .zip and strip on  -> rewritten without the outer folder (falls back to the original if unreadable)
 * - loose files / folder   -> zipped (folder picks drop the outer folder when `strip` is on)
 */
export async function buildArchive(
  items: PickedItem[],
  opts: { strip: boolean; folderName?: string },
): Promise<File> {
  if (items.length === 1 && items[0]!.file.name.toLowerCase().endsWith(".zip") && !items[0]!.path.includes("/")) {
    const f = items[0]!.file;
    if (!opts.strip) return f;
    await tick();
    const inner = await readZip(f);
    if (!inner) return f;
    const stripped = stripOuterFolder(inner);
    if (stripped === inner || stripped.length === 0) return f;
    return packFiles(stripped.map((e) => ({ path: e.path, data: e.data })), f.name);
  }
  await tick();
  const picked = opts.strip ? stripOuterFolder(items) : items;
  const files: Record<string, Uint8Array> = {};
  for (const it of picked) {
    if (JUNK.test(it.path)) continue;
    files[it.path] = new Uint8Array(await it.file.arrayBuffer());
  }
  const name =
    (opts.folderName ? opts.folderName : picked.length === 1 ? baseName(picked[0]!.file.name) : "upload") + ".zip";
  return packRecord(files, name);
}

function packFiles(list: { path: string; data: Uint8Array }[], name: string): File {
  const rec: Record<string, Uint8Array> = {};
  for (const e of list) rec[e.path] = e.data;
  return packRecord(rec, name);
}

function packRecord(rec: Record<string, Uint8Array>, name: string): File {
  const zipped = zipSync(
    Object.fromEntries(Object.entries(rec).map(([p, d]) => [p, [d, { level: 6, mtime: FIXED_TIME }] as [Uint8Array, { level: 6; mtime: Date }]])),
  );
  return new File([zipped as BlobPart], name, { type: "application/zip" });
}

/** Folder pick from <input webkitdirectory>: paths come from webkitRelativePath. */
export function fromFolderInput(list: FileList | File[]): { items: PickedItem[]; folderName: string } {
  const files = Array.from(list);
  const items = files.map((f) => ({ file: f, path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name }));
  const folderName = items[0]?.path.includes("/") ? items[0]!.path.split("/")[0]! : "upload";
  return { items, folderName };
}

/** Drag & drop: walks dropped files and folders. */
export async function fromDrop(dt: DataTransfer): Promise<{ items: PickedItem[]; folderName?: string }> {
  const out: PickedItem[] = [];
  let folderName: string | undefined;
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file, path: prefix + entry.name });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (batch.length === 0) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      }
    }
  };
  const entries = Array.from(dt.items ?? [])
    .map((i) => (typeof i.webkitGetAsEntry === "function" ? i.webkitGetAsEntry() : null))
    .filter((e): e is FileSystemEntry => !!e);
  if (entries.length === 0) return { items: Array.from(dt.files ?? []).map((f) => ({ file: f, path: f.name })) };
  if (entries.length === 1 && entries[0]!.isDirectory) folderName = entries[0]!.name;
  for (const e of entries) await walk(e, "");
  return { items: out, folderName };
}
