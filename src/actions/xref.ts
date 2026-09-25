"use server";

// The community parts cross-reference on the hub: add, fix, merge, remove, roll back.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { safe, UserError } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { modelKey, str } from "@/lib/format";
import { hubFetch, saveXPart, type HubXPart } from "@/lib/hub";
import { numberKey, parseFits, parseNumbers, parseSources, partKeys, splitList, type XFit, type XSource } from "@/lib/parts";

const KINDS = ["PART", "ACCESSORY", "SUPPLY"];

function refresh(id?: string) {
  revalidatePath("/xref");
  if (id) revalidatePath(`/xref/${id}`);
  revalidatePath("/parts", "layout");
}

/** Local entries that already use any of these numbers (besides `except`). */
async function numberOwner(numbers: { number: string }[], except?: string) {
  const keys = numbers.map((n) => numberKey(n.number)).filter(Boolean);
  if (!keys.length) return null;
  return db.xPart.findFirst({ where: { numberKeys: { hasSome: keys }, ...(except ? { id: { not: except } } : {}) }, select: { id: true, name: true } });
}

export const saveCrossRef = safe(async function saveCrossRef(id: string | null, formData: FormData) {
  const user = await requireUser();
  const prev = id ? await db.xPart.findUnique({ where: { id } }) : null;
  if (id && !prev) throw new UserError("That part isn't in the cross-reference any more. Sync and try again.");
  const kind = str(formData.get("kind")) ?? "PART";
  const body = {
    name: str(formData.get("name")),
    kind: KINDS.includes(kind) ? kind : "PART",
    category: str(formData.get("category")),
    specs: str(formData.get("specs")),
    notes: str(formData.get("notes")),
    numbers: parseNumbers(str(formData.get("numbers"))),
    fits: parseFits(str(formData.get("fits")), (prev?.fits as XFit[]) ?? []),
    sources: parseSources(str(formData.get("sources")), (prev?.sources as XSource[]) ?? []),
    byName: user.name,
    note: str(formData.get("note")),
  };
  if (!body.name) throw new UserError("Give the part a name, e.g. \"Needle plate screw\".");
  if (!body.numbers.length) throw new UserError("Add at least one part number (one per line: Brand, number).");
  const clash = await numberOwner(body.numbers, id ?? undefined);
  if (clash) throw new UserError(`One of those numbers is already on "${clash.name}". Open that part and merge the two instead.`);
  const x = (await (await hubFetch(id ? `/v1/xparts/${id}` : "/v1/xparts", { method: id ? "PUT" : "POST", json: body })).json()) as HubXPart;
  await saveXPart(x);
  refresh(x.id);
  if (!id) redirect(`/xref/${x.id}`);
});

/** Two entries turn out to be the same part: fold this one into the other. */
export const mergeCrossRef = safe(async function mergeCrossRef(id: string, formData: FormData) {
  const user = await requireUser();
  const target = str(formData.get("into"));
  if (!target) throw new UserError("Enter a part number from the other entry.");
  const into =
    (await db.xPart.findUnique({ where: { id: target }, select: { id: true } })) ??
    (await db.xPart.findFirst({ where: { numberKeys: { has: numberKey(target) }, id: { not: id } }, select: { id: true } }));
  if (!into || into.id === id) throw new UserError("No other cross-reference entry has that part number.");
  const merged = (await (await hubFetch(`/v1/xparts/${id}/merge`, { method: "POST", json: { intoId: into.id, byName: user.name, note: str(formData.get("note")) } })).json()) as HubXPart;
  await saveXPart(merged);
  await db.xPart.deleteMany({ where: { id } });
  refresh(merged.id);
  redirect(`/xref/${merged.id}`);
});

export const removeCrossRef = safe(async function removeCrossRef(id: string) {
  const user = await requireUser();
  await hubFetch(`/v1/xparts/${id}`, { method: "DELETE", json: { byName: user.name } });
  await db.xPart.deleteMany({ where: { id } });
  refresh();
  redirect("/xref");
});

export const revertCrossRef = safe(async function revertCrossRef(id: string, revisionId: string) {
  const user = await requireUser();
  const x = (await (await hubFetch(`/v1/xparts/${id}/revert`, { method: "POST", json: { revisionId, byName: user.name } })).json()) as HubXPart;
  await saveXPart(x);
  refresh(id);
});

export type XRevision = { id: string; action: string; snapshot: HubXPart; byName: string | null; byShop: string | null; note: string | null; createdAt: string };

export async function crossRefHistory(id: string): Promise<{ revisions: XRevision[] } | { error: string }> {
  try {
    await requireUser();
    return { revisions: (await (await hubFetch(`/v1/xparts/${id}/history`)).json()) as XRevision[] };
  } catch (e) {
    return { error: e instanceof UserError ? e.message : "Couldn't load the history from the hub." };
  }
}

/** Put one of this shop's parts on the community cross-reference (or open the entry that already has it). */
export const addPartToCrossRef = safe(async function addPartToCrossRef(partId: string) {
  const user = await requireUser();
  const p = await db.part.findFirst({ where: { id: partId, shopId: user.shopId } });
  if (!p) throw new UserError("Part not found.");
  const existing = await db.xPart.findFirst({ where: { numberKeys: { hasSome: partKeys(p.partNumber, p.altNumbers) } }, select: { id: true } });
  if (existing) redirect(`/xref/${existing.id}`);
  const brand = p.brand ?? "Generic";
  const body = {
    name: p.description,
    kind: p.kind,
    category: null,
    specs: null,
    notes: p.notes,
    numbers: [{ brand, number: p.partNumber }, ...p.altNumbers.map((n) => ({ brand: "Generic", number: n }))],
    fits: splitList(p.fits).map((m) => ({ brand, model: m, modelKey: modelKey(m), evidence: "tested", source: null })),
    sources: [],
    byName: user.name,
    note: "added from a shop's parts list",
  };
  const x = (await (await hubFetch("/v1/xparts", { method: "POST", json: body })).json()) as HubXPart;
  await saveXPart(x);
  refresh(x.id);
  redirect(`/xref/${x.id}`);
});
