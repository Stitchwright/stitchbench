"use server";

// Wholesaler catalog import (fabric-smarts-design.md section 5a, package F6): the mapping step reads the chosen file,
// the preview is the dry run (counts, nothing written), and apply writes. The file is sent each time (nothing is kept on
// the server between steps), so what is applied is exactly what was previewed. Bodies in src/lib/connectors/catalog.ts.
import { revalidatePath } from "next/cache";
import { noted, safe } from "@/lib/action";
import { UserError, isUserError } from "@/lib/user-error";
import { requireAdmin } from "@/lib/session";
import { applyCatalogFor, previewCatalogFor, sheetViewFor, type CatalogPreview, type SheetView } from "@/lib/connectors/catalog";
import { MAX_SHEET_BYTES } from "@/lib/connectors/sheet";

async function fileOf(fd: FormData): Promise<{ name: string; bytes: Uint8Array }> {
  const f = fd.get("file");
  if (!(f instanceof File) || f.size === 0) throw new UserError("Choose the catalog file (CSV or Excel).");
  if (f.size > MAX_SHEET_BYTES) throw new UserError(`That file is larger than ${MAX_SHEET_BYTES / 1024 / 1024} MB. Split it and import in parts.`);
  return { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
}

function mapOf(fd: FormData): unknown {
  try {
    return JSON.parse(String(fd.get("map") ?? "{}"));
  } catch {
    return {};
  }
}

/** Step 1: the file's headings and first rows, and the column map to start from. Reads only. */
export async function readCatalogSheet(supplierId: string, fd: FormData): Promise<{ view: SheetView } | { error: string }> {
  try {
    const user = await requireAdmin();
    const f = await fileOf(fd);
    return { view: await sheetViewFor(user, supplierId, f.name, f.bytes) };
  } catch (e) {
    if (isUserError(e)) return { error: e.message };
    throw e;
  }
}

/** Step 2: the dry run. Reads only. */
export async function previewCatalog(supplierId: string, fd: FormData): Promise<{ preview: CatalogPreview } | { error: string }> {
  try {
    const user = await requireAdmin();
    const f = await fileOf(fd);
    return { preview: await previewCatalogFor(user, supplierId, f.name, f.bytes, mapOf(fd), String(fd.get("defaultKind") ?? "") || null) };
  } catch (e) {
    if (isUserError(e)) return { error: e.message };
    throw e;
  }
}

/** Step 3: apply (refused while the program key has lapsed: it makes and changes stock items). */
export const applyCatalog = safe(async function applyCatalog(supplierId: string, fd: FormData) {
  const user = await requireAdmin();
  const f = await fileOf(fd);
  const text = await applyCatalogFor(user, supplierId, f.name, f.bytes, mapOf(fd), fd.get("saveMap") === "on", String(fd.get("defaultKind") ?? "") || null);
  revalidatePath("/fabric");
  revalidatePath("/parts", "layout");
  return noted(text);
});
