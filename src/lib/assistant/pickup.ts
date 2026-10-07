import "server-only";
// "Draft the pickup sheet" on a ticket and "Say it in words" on fabric insight (shop-features-round-2-design.md 5.5).
// Each is a button a person pressed; one call through the hub, logged and counted. The pickup sheet's words go into the
// form (nothing is saved until she saves) and its tips are picked only from the shop's own list; the insight sentences
// are shown under the program's own cards and not stored.
import { db } from "@/lib/db";
import { careTipsFor } from "@/lib/care-tips";
import { insightFor } from "@/lib/fabric-insight";
import { requireOn } from "@/lib/module-gate";
import type { CurrentUser } from "@/lib/session";
import { UserError } from "@/lib/user-error";
import { runAssistant } from "./client";
import { ticketContext, voiceFor } from "./context";
import { buildInsightWords, insightCards, parseInsightWords, type InsightCard } from "./insight-words";
import { buildPickupSheet, parsePickupSheet } from "./pickup-prompt";

type Who = Pick<CurrentUser, "id" | "shopId" | "role">;

export async function draftPickup(user: Who, ticketId: string): Promise<{ what: string; tipIds: string[] }> {
  await requireOn(user as CurrentUser, "assistant");
  const ctx = await ticketContext(user.shopId, ticketId);
  const machine = await db.machine.findFirst({ where: { id: ctx.ids.machineId, shopId: user.shopId }, select: { kind: true } });
  if (!ctx.facts.workDone && !ctx.facts.lines.length && !ctx.facts.diagnosis) throw new UserError("Fill in the work done (or the bill's lines) first: the sheet is written from them.");
  const tips = (await careTipsFor(user.shopId, machine?.kind ?? "sewing")).map((t, i) => ({ n: i + 1, id: t.id, text: t.text }));
  const { text } = await runAssistant({
    shopId: user.shopId,
    userId: user.id,
    built: buildPickupSheet(ctx.facts, tips, await voiceFor(user.shopId), ctx.redaction),
    target: { ticketId: ctx.ids.ticketId, machineId: ctx.ids.machineId },
    serials: ctx.redaction.serials,
  });
  const sheet = parsePickupSheet(text, tips.map((t) => t.n));
  if (!sheet) throw new UserError("The Assistant's answer couldn't be read. Try again, or write it yourself.");
  return { what: sheet.what, tipIds: sheet.tips.map((n) => tips[n - 1].id) };
}

export async function explainInsight(user: Who, tab: string): Promise<{ cards: InsightCard[]; words: Record<string, string> }> {
  await requireOn(user as CurrentUser, "assistant");
  const which = tab === "slow" ? "slow" : "sells";
  const cards = insightCards(await insightFor(user.shopId), which);
  if (!cards.length) throw new UserError("There isn't enough to say yet. Once more fabric has sold (or sat), try again.");
  const shop = await db.shop.findUnique({ where: { id: user.shopId }, select: { name: true } });
  const { text } = await runAssistant({ shopId: user.shopId, userId: user.id, built: buildInsightWords(cards, { shopName: shop?.name ?? "", sample: null }) });
  const words = parseInsightWords(text, cards);
  if (!words) throw new UserError("The Assistant's answer couldn't be read. Try again.");
  return { cards, words };
}
