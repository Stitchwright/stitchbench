import "server-only";
// The trade-in helper (shop-features-round-2-design.md 5.4): "Draft a condition note" on the register's trade-in step.
// One picture (the browser puts up to four condition photos side by side), one trade_in_note call through the hub
// (counted, group "Read the plate"). The note goes in the trade-in's form for staff to change; it is kept on the
// machine for sale, staff only, never on a receipt.
import { requireOn } from "@/lib/module-gate";
import type { CurrentUser } from "@/lib/session";
import { usableKind } from "@/lib/equipment/shop";
import { UserError } from "@/lib/user-error";
import { runAssistant, type Photo } from "./client";
import { buildTradeInNote, cleanNote } from "./trade-in-prompt";

export async function tradeInNote(user: Pick<CurrentUser, "id" | "shopId" | "role">, o: { photo: Photo; photos: number; kind?: string | null; brand: string; model: string }): Promise<string> {
  await requireOn(user as CurrentUser, "assistant");
  const kind = o.kind ? await usableKind(user.shopId, o.kind) : null;
  const photos = Math.min(5, Math.max(1, Math.round(Number(o.photos) || 1)));
  const { text } = await runAssistant({ shopId: user.shopId, userId: user.id, built: buildTradeInNote({ noun: kind?.noun ?? "machine", brand: o.brand, model: o.model, photos }), photo: o.photo });
  const note = cleanNote(text);
  if (!note) throw new UserError("The Assistant couldn't see enough in those photos. Take them again in good light, or write the note yourself.");
  return note;
}
