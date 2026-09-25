import "server-only";
import fs from "node:fs";
import path from "node:path";

// When StitchBench runs as the Windows program on the shop PC, its server reads the manual library
// straight from disk (LIBRARY_DIR, e.g. C:\Manuals), so every device on the shop network can open manuals.
export function libraryDir(): string | null {
  const dir = process.env.LIBRARY_DIR;
  if (!dir) return null;
  const abs = path.resolve(dir);
  return fs.existsSync(abs) ? abs : null;
}

/** A PDF path inside the library, or null if it points anywhere else. */
export function resolveInLibrary(root: string, rel: string): string | null {
  if (!rel || rel.includes("\0")) return null;
  const full = path.resolve(root, rel.split(/[\\/]+/).join(path.sep));
  const inside = path.relative(root, full);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) return null;
  if (!/\.pdf$/i.test(full)) return null;
  return full;
}
