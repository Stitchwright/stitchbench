"use server";

// The community parts cross-reference on the hub: add, fix, merge, remove, roll back.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { safe, UserError, isUserError } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { brandKey, str } from "@/lib/format";
import { hubFetch, hubId, hubStatus, saveXPart, type HubXPart } from "@/lib/hub";
import { numberKey, parseFits, parseNumbers, parseSources, partKeys, type XFit, type XNumber, type XSource } from "@/lib/parts";

const KINDS = ["PART", "ACCESSORY", "SUPPLY"];

function refresh(id?: string) {
  revalidatePath("/xref");
  if (id) revalidatePath(`/xref/${id}`);
  revalidatePath("/parts", "layout");
}

/**
 * The local entry that already has one of these numbers under the same brand (besides `except`): the hub's rule. The
 * same number from another maker is another part ("Janome, 12345" and "Singer, 12345"), and a one- or two-character
 * number says too little to tell parts apart.
 */
async function numberOwner(numbers: XNumber[], except?: string) {
  const want = numbers.map((n) => ({ brand: brandKey(n.brand), key: numberKey(n.number) })).filter((w) => w.key.length >= 3);
  if (!want.length) return null;
  const near = await db.xPart.findMany({
    where: { numberKeys: { hasSome: want.map((w) => w.key) }, ...(except ? { id: { not: except } } : {}) },
    select: { id: true, name: true, numbers: true },
    take: 200,
  });
  return near.find((x) => (x.numbers as XNumber[]).some((xn) => want.some((w) => w.key === numberKey(xn.number) && w.brand === brandKey(xn.brand)))) ?? null;
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
    // The version this form was filled from: the hub refuses the edit when the entry changed since (the whole entry is
    // replaced, so it would undo another shop's fix or the supplier scan's links).
    ...(prev ? { baseUpdatedAt: str(formData.get("baseUpdatedAt")) ?? prev.updatedAt.toISOString() } : {}),
  };
  if (!body.name) throw new UserError("Give the part a name, e.g. \"Needle plate screw\".");
  // A part the maker gave no number is known by its name and the models it fits.
  if (!body.numbers.length && !body.fits.length) throw new UserError("Add at least one part number (one per line: Brand, number), or the models it fits if the maker gave none.");
  const clash = await numberOwner(body.numbers, id ?? undefined);
  if (clash) throw new UserError(`One of those numbers is already on "${clash.name}" (same brand). If it is the same part, open that one and merge the two instead.`);
  let x: HubXPart;
  try {
    x = (await (await hubFetch(id ? `/v1/xparts/${hubId(id)}` : "/v1/xparts", { method: id ? "PUT" : "POST", json: body })).json()) as HubXPart;
  } catch (e) {
    // Changed on the hub since: this copy takes the current entry, so the page shows what the other change was.
    if (id && hubStatus(e) === 409 && "baseUpdatedAt" in body) {
      const now = await hubFetch(`/v1/xparts/${hubId(id)}`).then((r) => r.json() as Promise<HubXPart>, () => null);
      if (now) await saveXPart(now);
      refresh(id);
    }
    throw e;
  }
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
  const merged = (await (await hubFetch(`/v1/xparts/${hubId(id)}/merge`, { method: "POST", json: { intoId: into.id, byName: user.name, note: str(formData.get("note")) } })).json()) as HubXPart;
  await saveXPart(merged);
  await db.xPart.deleteMany({ where: { id } });
  refresh(merged.id);
  redirect(`/xref/${merged.id}`);
});

export const removeCrossRef = safe(async function removeCrossRef(id: string) {
  const user = await requireUser();
  const x = (await (await hubFetch(`/v1/xparts/${hubId(id)}`, { method: "DELETE", json: { byName: user.name } })).json()) as HubXPart;
  // Kept aside as removed (listed on the cross-reference page, where it can be put back).
  await saveXPart({ ...x, deleted: true });
  refresh();
  redirect("/xref");
});

/** Put back an entry someone removed, with its numbers, fits and links as they were. */
export const restoreCrossRef = safe(async function restoreCrossRef(id: string) {
  const user = await requireUser();
  const x = (await (await hubFetch(`/v1/xparts/${hubId(id)}/restore`, { method: "POST", json: { byName: user.name } })).json()) as HubXPart;
  await saveXPart(x);
  refresh(x.id);
  redirect(`/xref/${x.id}`);
});

export const revertCrossRef = safe(async function revertCrossRef(id: string, revisionId: string) {
  const user = await requireUser();
  const x = (await (await hubFetch(`/v1/xparts/${hubId(id)}/revert`, { method: "POST", json: { revisionId, byName: user.name } })).json()) as HubXPart;
  await saveXPart(x);
  refresh(id);
});

export type XRevision = { id: string; action: string; snapshot: HubXPart; byName: string | null; byShop: string | null; note: string | null; createdAt: string };

export async function crossRefHistory(id: string): Promise<{ revisions: XRevision[] } | { error: string }> {
  try {
    await requireUser();
    return { revisions: (await (await hubFetch(`/v1/xparts/${hubId(id)}/history`)).json()) as XRevision[] };
  } catch (e) {
    return { error: isUserError(e) ? e.message : "Couldn't load the history from the hub." };
  }
}

/**
 * Offer one of this shop's parts to the community cross-reference (or open the entry that already has it). Nothing is
 * sent from here: the cross-reference form opens filled in from the part (never its private notes), for the shop to
 * check and send.
 */
export const addPartToCrossRef = safe(async function addPartToCrossRef(partId: string) {
  const user = await requireUser();
  const p = await db.part.findFirst({ where: { id: partId, shopId: user.shopId }, select: { id: true, partNumber: true, altNumbers: true, ownNumber: true } });
  if (!p) throw new UserError("Part not found.");
  // A shop number isn't the maker's, so it doesn't find (or make) an entry.
  const existing = await db.xPart.findFirst({ where: { numberKeys: { hasSome: partKeys(p.ownNumber ? "" : p.partNumber, p.altNumbers) } }, select: { id: true } });
  if (existing) redirect(`/xref/${existing.id}`);
  redirect(`/xref?add=${encodeURIComponent(p.id)}#add`);
});
