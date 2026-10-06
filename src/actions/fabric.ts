"use server";

// The Fabric page (fabric-smarts-design.md, packages F1 and F2): cut a bolt end, add a collection, mark a fabric down a
// step (and undo it the same day), the cut prices, bolt-end size and insight thresholds in Settings. Bodies in
// src/lib/fabric.ts and src/lib/fabric-insight.ts. Each is refused while the program key has lapsed (safe() with no
// exception: they are new stock work).
import { revalidatePath } from "next/cache";
import { noted, safe, UserError } from "@/lib/action";
import { db } from "@/lib/db";
import { str } from "@/lib/format";
import { requireAdmin, requireUser } from "@/lib/session";
import { addCollectionFor, cutFor } from "@/lib/fabric";
import { CUT_KINDS, type CutKind } from "@/lib/fabric-math";
import { inEighths } from "@/lib/register-math";
import { markDownFor, undoMarkdownFor, type MarkdownSource } from "@/lib/fabric-insight";
import { INSIGHT_FIELDS, INSIGHT_SELECT, settingsProblem, type InsightSettings } from "@/lib/fabric-insight-math";

export const cutBoltEnd = safe(async function cutBoltEnd(partId: string, kind: CutKind) {
  const user = await requireUser();
  if (!CUT_KINDS.includes(kind)) throw new UserError("Pick fat quarters, half yards or remnant.");
  const text = await cutFor(user, partId, kind);
  revalidatePath("/fabric");
  revalidatePath("/parts");
  return noted(text);
});

export const markDown = safe(async function markDown(partId: string, source: MarkdownSource) {
  const user = await requireUser();
  const text = await markDownFor(user, partId, source === "bolt" ? "bolt" : "slow");
  revalidatePath("/fabric");
  revalidatePath("/parts");
  return noted(text);
});

export const undoMarkdown = safe(async function undoMarkdown(markdownId: string) {
  const user = await requireUser();
  const text = await undoMarkdownFor(user, markdownId);
  revalidatePath("/fabric");
  revalidatePath("/parts");
  return noted(text);
});

export const addCollection = safe(async function addCollection(formData: FormData) {
  const user = await requireUser();
  const n = await addCollectionFor(user, formData);
  revalidatePath("/fabric");
  revalidatePath("/parts");
  return noted(`Added ${n} ${n === 1 ? "fabric" : "fabrics"}.`);
});

export const saveFabricSettings = safe(async function saveFabricSettings(formData: FormData) {
  const user = await requireAdmin();
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { fatQuarterMarkupPct: true, halfYardMarkupPct: true, remnantPricePct: true, boltEndYards: true, ...INSIGHT_SELECT } });
  const num = (k: string, label: string, d: number, min: number, max: number) => {
    const s = str(String(formData.get(k) ?? "").replace(/[%,]/g, ""));
    if (s == null) return d;
    const v = Number(s);
    if (!Number.isFinite(v) || v < min || v > max) throw new UserError(`${label}: enter a number from ${min} to ${max}.`);
    return v;
  };
  const boltEndYards = num("boltEndYards", "Bolt end (yards)", shop.boltEndYards, 0.125, 5);
  if (!inEighths(boltEndYards)) throw new UserError("Bolt end (yards): fabric is counted in eighths of a yard (1/8 = 0.125).");
  // The insight thresholds: a blank box keeps what is saved; whole numbers except the GMROI figures; dollars for cents.
  const insight = { ...INSIGHT_SELECT } as unknown as InsightSettings;
  for (const f of INSIGHT_FIELDS) {
    const old = shop[f.key];
    const label = f.label.replace(/ (.*)$/, "");
    if (f.kind === "cents") insight[f.key] = Math.round(num(f.key, label, old / 100, f.min, f.max) * 100);
    else {
      const v = num(f.key, label, old, f.min, f.max);
      if (f.kind === "int" && !Number.isInteger(v)) throw new UserError(`${label}: enter a whole number.`);
      insight[f.key] = v;
    }
  }
  const problem = settingsProblem(insight);
  if (problem) throw new UserError(problem);
  await db.shop.update({
    where: { id: user.shopId },
    data: {
      ...insight,
      fatQuarterMarkupPct: num("fatQuarterMarkupPct", "Fat quarter markup", shop.fatQuarterMarkupPct, 0, 200),
      halfYardMarkupPct: num("halfYardMarkupPct", "Half yard markup", shop.halfYardMarkupPct, 0, 200),
      remnantPricePct: num("remnantPricePct", "Remnant price", shop.remnantPricePct, 1, 100),
      boltEndYards,
    },
  });
  revalidatePath("/fabric");
  revalidatePath("/settings");
});
