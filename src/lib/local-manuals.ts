// The tech's own manual library, kept on their own PC or laptop.
// Nothing here is uploaded: the browser remembers the folder (File System Access
// API, Chrome/Edge) and an index of its PDF file names in IndexedDB.
// Browsers without folder access (Firefox, Safari) can pick the folder each visit.

import { brandKey, modelKey } from "@/lib/format";

export type IndexedFile = { path: string; name: string; size: number };
export type LibraryIndex = { folderName: string; scannedAt: string; files: IndexedFile[]; mode: "folder" | "session" };

type DirHandle = FileSystemDirectoryHandle & {
  values(): AsyncIterable<FileSystemDirectoryHandle | FileSystemFileHandle>;
  queryPermission(o: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission(o: { mode: "read" | "readwrite" }): Promise<PermissionState>;
};

const DB_NAME = "stitchbench-local";
const STORE = "kv";

function openIdb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const d = await openIdb();
  return new Promise((res, rej) => {
    const r = d.transaction(STORE).objectStore(STORE).get(key);
    r.onsuccess = () => res(r.result as T | undefined);
    r.onerror = () => rej(r.error);
  });
}

async function idbSet(key: string, val: unknown): Promise<void> {
  const d = await openIdb();
  return new Promise((res, rej) => {
    const tx = d.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

async function idbDel(key: string): Promise<void> {
  const d = await openIdb();
  return new Promise((res, rej) => {
    const tx = d.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

// Files picked through the fallback folder input live only for this page visit.
const sessionFiles = new Map<string, File>();

export function folderAccessSupported(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

export async function loadIndex(): Promise<LibraryIndex | undefined> {
  try {
    return await idbGet<LibraryIndex>("index");
  } catch {
    return undefined;
  }
}

async function getRoot(): Promise<DirHandle | undefined> {
  return idbGet<DirHandle>("root");
}

async function ensurePermission(h: DirHandle, mode: "read" | "readwrite"): Promise<boolean> {
  if ((await h.queryPermission({ mode })) === "granted") return true;
  return (await h.requestPermission({ mode })) === "granted";
}

async function walk(dir: DirHandle, prefix: string, out: IndexedFile[], onProgress?: (n: number) => void, depth = 0) {
  if (depth > 12) return;
  for await (const h of dir.values()) {
    if (h.name.startsWith(".") || h.name === "node_modules" || h.name === "$RECYCLE.BIN") continue;
    const path = prefix ? `${prefix}/${h.name}` : h.name;
    if (h.kind === "directory") {
      await walk(h as DirHandle, path, out, onProgress, depth + 1);
    } else if (/\.pdf$/i.test(h.name)) {
      const f = await (h as FileSystemFileHandle).getFile();
      out.push({ path, name: h.name, size: f.size });
      if (out.length % 200 === 0) onProgress?.(out.length);
    }
  }
}

/** Ask the tech to pick their manuals folder, remember it, and index it. */
export async function connectFolder(onProgress?: (n: number) => void): Promise<LibraryIndex> {
  const picker = (window as unknown as { showDirectoryPicker: (o: object) => Promise<DirHandle> }).showDirectoryPicker;
  const root = await picker({ id: "manuals", mode: "readwrite" });
  await idbSet("root", root);
  return rescan(onProgress, root);
}

export async function rescan(onProgress?: (n: number) => void, rootArg?: DirHandle): Promise<LibraryIndex> {
  const root = rootArg ?? (await getRoot());
  if (!root) throw new Error("Connect your manuals folder first.");
  if (!(await ensurePermission(root, "read"))) throw new Error("The browser was not allowed to read the manuals folder.");
  const files: IndexedFile[] = [];
  await walk(root, "", files, onProgress);
  const index: LibraryIndex = { folderName: root.name, scannedAt: new Date().toISOString(), files, mode: "folder" };
  await idbSet("index", index);
  return index;
}

/** Fallback for browsers without folder access: index files from <input webkitdirectory>. */
export async function indexPickedFiles(list: FileList): Promise<LibraryIndex> {
  sessionFiles.clear();
  const files: IndexedFile[] = [];
  let folderName = "";
  for (const f of Array.from(list)) {
    if (!/\.pdf$/i.test(f.name)) continue;
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    const parts = rel.split("/");
    folderName ||= parts[0];
    const path = parts.slice(1).join("/") || f.name;
    sessionFiles.set(path, f);
    files.push({ path, name: f.name, size: f.size });
  }
  const index: LibraryIndex = { folderName, scannedAt: new Date().toISOString(), files, mode: "session" };
  await idbSet("index", index);
  return index;
}

export async function disconnect(): Promise<void> {
  sessionFiles.clear();
  await idbDel("root");
  await idbDel("index");
}

/** Is the manuals folder readable right now without asking? (Browsers may re-ask after a restart.) */
export async function canReadWithoutPrompt(): Promise<boolean> {
  try {
    const root = await getRoot();
    if (!root) return sessionFiles.size > 0;
    return (await root.queryPermission({ mode: "read" })) === "granted";
  } catch {
    return false;
  }
}

export async function getLocalFile(path: string): Promise<File> {
  return fileAt(path);
}

// ---------- the shop PC's library (Windows program) ----------
// The desktop program's server reads the library from disk, so any device on the shop network can open
// manuals without connecting a folder. Paths with this prefix come from there instead of this PC.
export const SERVER_PREFIX = "server:";
let serverLib: Promise<boolean> | null = null;

export function serverLibrary(): Promise<boolean> {
  serverLib ??= fetch("/api/library/status")
    .then((r) => (r.ok ? r.json() : { enabled: false }))
    .then((j: { enabled?: boolean }) => Boolean(j.enabled))
    .catch(() => false);
  return serverLib;
}

function serverUrl(path: string) {
  return `/api/library/file?path=${encodeURIComponent(path.slice(SERVER_PREFIX.length).split("\\").join("/"))}`;
}

/** Where to read a library manual from: this PC's connected folder first, then the shop PC. */
export async function manualPath(index: LibraryIndex | undefined, libPath: string): Promise<string | null> {
  const local = findByPath(index, libPath)?.path;
  if (local) return local;
  // The shop PC needs the path inside the library (Category\Brand\File.pdf), not just a file name.
  return /[\\/]/.test(libPath) && (await serverLibrary()) ? SERVER_PREFIX + libPath : null;
}

async function fileAt(path: string): Promise<File> {
  if (path.startsWith(SERVER_PREFIX)) {
    const r = await fetch(serverUrl(path));
    if (!r.ok) throw new Error((await r.text()) || "Could not get that manual from the shop PC.");
    return new File([await r.blob()], path.split(/[\\/]/).pop() ?? "manual.pdf", { type: "application/pdf" });
  }
  const s = sessionFiles.get(path);
  if (s) return s;
  const root = await getRoot();
  if (!root) throw new Error("This manual was indexed from a folder picked for one visit only. Pick the folder again on the My manuals page.");
  if (!(await ensurePermission(root, "read"))) throw new Error("The browser was not allowed to read the manuals folder.");
  const parts = path.split("/");
  let dir: FileSystemDirectoryHandle = root;
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
  return (await dir.getFileHandle(parts[parts.length - 1])).getFile();
}

/** Open a manual from the tech's own disk in a new tab, optionally at a page. */
export async function openLocal(path: string, page?: number | null): Promise<void> {
  if (path.startsWith(SERVER_PREFIX)) {
    window.open(serverUrl(path) + (page ? `#page=${page}` : ""), "_blank");
    return;
  }
  // Open the tab first, while the click still counts as a user action, then point it at the file.
  const w = window.open("", "_blank");
  try {
    const f = await fileAt(path);
    const url = URL.createObjectURL(f);
    const target = page ? `${url}#page=${page}` : url;
    if (w) w.location.href = target;
    else window.location.href = target;
  } catch (e) {
    w?.close();
    throw e;
  }
}

/** Save a new PDF (e.g. a scan) into <library>/<Brand>/ and add it to the index. */
export async function saveToLibrary(blob: Blob, brand: string, filename: string): Promise<{ saved: "library" | "shop" | "download"; path: string }> {
  const root = await getRoot();
  if (!root && (await serverLibrary())) {
    const fd = new FormData();
    fd.set("file", blob, filename);
    fd.set("filename", filename);
    const r = await fetch("/api/library/file", { method: "POST", body: fd });
    if (!r.ok) throw new Error((await r.text()) || "Could not save to the shop library.");
    return { saved: "shop", path: ((await r.json()) as { path: string }).path };
  }
  if (root && (await ensurePermission(root, "readwrite"))) {
    const folder = brand.replace(/[^\w\- ]+/g, "").trim() || "Unsorted";
    const dir = await root.getDirectoryHandle(folder, { create: true });
    const fh = await dir.getFileHandle(filename, { create: true });
    const w = await (fh as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
    await w.write(blob);
    await w.close();
    const path = `${folder}/${filename}`;
    const index = (await loadIndex()) ?? { folderName: root.name, scannedAt: new Date().toISOString(), files: [], mode: "folder" as const };
    index.files = index.files.filter((f) => f.path !== path).concat({ path, name: filename, size: blob.size });
    await idbSet("index", index);
    return { saved: "library", path };
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return { saved: "download", path: filename };
}

const DOC_RANK: [RegExp, number][] = [
  [/service|technical|adjust|repair|engineer/i, 4],
  [/maintenance|troubleshoot|error/i, 3],
  [/operator|instruction|owner|user|manual/i, 2],
  [/parts/i, 1],
];

export type ManualMatch = IndexedFile & { score: number };

/** Manuals in the local index that look like they cover this brand + model. */
export function findManuals(index: LibraryIndex | undefined, brand: string, model: string, limit = 12): ManualMatch[] {
  if (!index) return [];
  const mk = modelKey(model);
  const bk = brandKey(brand);
  if (!mk) return [];
  const out: ManualMatch[] = [];
  for (const f of index.files) {
    const tokens = f.path.toUpperCase().split(/[\\/_\-\s+.,()]+/).map((t) => t.replace(/[^A-Z0-9]/g, ""));
    const flat = f.path.toUpperCase().replace(/[^A-Z0-9]/g, "");
    let score = 0;
    if (tokens.includes(mk)) score = 12;
    else if (mk.length >= 4 && flat.includes(mk)) score = 8;
    if (!score) continue;
    if (bk && flat.includes(bk)) score += 3;
    for (const [re, n] of DOC_RANK) {
      if (re.test(f.name)) {
        score += n;
        break;
      }
    }
    out.push({ ...f, score });
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
}

export function findByName(index: LibraryIndex | undefined, name: string): IndexedFile | undefined {
  if (!index) return undefined;
  const n = name.toLowerCase();
  return index.files.find((f) => f.name.toLowerCase() === n);
}

/**
 * Find a library file by its path relative to the library root (e.g. Sewing\Janome\X.pdf).
 * Works whether the tech connected the whole library folder or a sub-folder of it; falls back to the file name.
 */
export function findByPath(index: LibraryIndex | undefined, libPath: string): IndexedFile | undefined {
  if (!index) return undefined;
  const want = libPath.split("\\").join("/").toLowerCase();
  const name = want.split("/").pop()!;
  let byName: IndexedFile | undefined;
  for (const f of index.files) {
    if (f.name.toLowerCase() !== name) continue;
    const have = f.path.toLowerCase();
    if (want === have || want.endsWith("/" + have) || have.endsWith("/" + want)) return f;
    byName ??= f;
  }
  return byName;
}

export function firstPage(pages: string | null | undefined): number | null {
  const m = pages?.match(/\d+/);
  return m ? Number(m[0]) : null;
}
