import "server-only";
import fs from "node:fs";
import path from "node:path";
import { under } from "@/lib/opaque-path";

// When StitchBench runs as the Windows program on the shop PC, its server reads the manual library
// straight from disk (LIBRARY_DIR, e.g. C:\Manuals), so every device on the shop network can open manuals.
export function libraryDir(): string | null {
  const dir = process.env.LIBRARY_DIR;
  if (!dir) return null;
  const abs = path.resolve(dir);
  return fs.existsSync(abs) ? abs : null;
}

// Folders in the library that hold the shop's own business papers, not manuals: draft price sheets, forms, the notes
// and guides the shop writes to sell (_own-notes, one per category). Never served to anyone, whoever is signed in.
const PRIVATE_FOLDERS = new Set(["_business-notes", "_own-notes"]);

/**
 * Save a PDF in `dir` as "<stem>.pdf", or "<stem> (2).pdf" and so on when the name is taken. The write itself is the
 * test for a free name ("wx" refuses an existing file), so two saves of the same name at the same moment each get a
 * file of their own instead of one of them failing. Returns the name it used.
 */
export async function writeUnusedPdf(dir: string, stem: string, bytes: Uint8Array): Promise<string> {
  for (let i = 1; i < 1000; i++) {
    const name = i === 1 ? `${stem}.pdf` : `${stem} (${i}).pdf`;
    try {
      await fs.promises.writeFile(under(dir, name), bytes, { flag: "wx" });
      return name;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw new Error("Too many files with that name in the inbox.");
}

/** A PDF path inside the library (and not in a private folder), or null if it points anywhere else. */
export function resolveInLibrary(root: string, rel: string): string | null {
  if (!rel || rel.includes("\0")) return null;
  const full = path.resolve(root, rel.split(/[\\/]+/).join(path.sep));
  const inside = path.relative(root, full);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) return null;
  if (inside.split(path.sep).some((folder) => PRIVATE_FOLDERS.has(folder.toLowerCase()))) return null;
  if (!/\.pdf$/i.test(full)) return null;
  return full;
}
