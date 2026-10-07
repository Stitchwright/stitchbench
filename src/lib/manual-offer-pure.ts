// The parts of offering a manual that the browser shares with the server (no "server-only", no database): the limits, the
// statement's words, the quick PDF checks and the dialog's first guess. src/lib/manual-repository.ts re-exports them.
import { DOC_TYPES } from "@/lib/constants";
import { UserError } from "@/lib/user-error";

const MB = 1024 * 1024;
export const REPO_MAX_BYTES = 150 * MB;
/** Names the words the person ticked (REPO_STATEMENT_VERSION on the hub, when set, must match it). */
export const STATEMENT_VERSION = "2026-10-a";
export const STATEMENT =
  "I may share this file with every shop on StitchHub: its maker publishes it for anyone to download, or my shop made it, or its copyright owner allows sharing. If its owner sends a valid copyright notice, StitchHub removes it and this account gets a strike; three strikes in a year end this account's uploading.";
export const REVIEW_NOTE = "The hub's owner reviews it before other shops can download it. Other shops don't see who offered it.";
export const SOON = "The manual repository opens soon.";

export const sizeWords = (n: number) => (n >= 1024 * MB ? `${(n / (1024 * MB)).toFixed(1)} GB` : n >= MB ? `${(n / MB).toFixed(n >= 10 * MB ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

const latin1 = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
};

/** The checks a file can fail on by its first and last bytes: a PDF, not encrypted, at most 150 MB. Throws a UserError in words. */
export function checkPdfParts(head: Uint8Array, tail: Uint8Array, size: number): void {
  if (size > REPO_MAX_BYTES) throw new UserError(`That file is ${sizeWords(size)}; the repository takes up to ${sizeWords(REPO_MAX_BYTES)}.`);
  if (latin1(head.subarray(0, 5)) !== "%PDF-") throw new UserError("That isn't a PDF (it doesn't start with %PDF-), so it can't be offered.");
  if (/\/Encrypt(?![A-Za-z])/.test(latin1(head) + latin1(tail))) {
    throw new UserError("That PDF is encrypted, so it can't be offered. Saving it again with Microsoft Print to PDF makes an ordinary copy if you are allowed to have one.");
  }
}

/** The same checks on a whole file already in memory. */
export function checkPdfBytes(b: Uint8Array): void {
  checkPdfParts(b.subarray(0, 65536), b.subarray(Math.max(0, b.length - 65536)), b.length);
}

/** Folders in the library that are never offered (the shop's own business papers). */
export const PRIVATE_LIBRARY_FOLDERS = ["_business-notes", "_own-notes"];

export type OfferGuess = Partial<Record<"category" | "brand" | "models" | "docType" | "year" | "language" | "title", string>>;

/**
 * What the dialog starts with: the LibraryDoc's own words, else a `Brand_Model_DocType_Year.pdf` name taken apart, else
 * blank (an _inbox file). Only a first guess: the person reads and changes every field.
 */
export function guessFields(fileName: string, doc?: { category: string; brand: string; docType: string | null; title: string | null } | null): OfferGuess {
  const stem = fileName.replace(/\.pdf$/i, "").replace(/ \(\d+\)$/, "");
  const parts = stem.split("_");
  const out: OfferGuess = {};
  if (parts.length >= 3) {
    out.brand = parts[0];
    out.models = parts[1].split("+").join(", ");
    const dt = DOC_TYPES.find((d) => d.toLowerCase() === parts[2].toLowerCase());
    if (dt) out.docType = dt;
    if (/^(19|20)\d\d$/.test(parts[3] ?? "")) out.year = parts[3];
  }
  if (doc) {
    out.category = doc.category;
    out.brand = doc.brand;
    if (doc.docType && (DOC_TYPES as readonly string[]).includes(doc.docType)) out.docType = doc.docType;
    if (doc.title) out.title = doc.title;
  }
  return out;
}
