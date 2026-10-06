import "server-only";
// What the ticket's Assistant card shows (src/components/slots/ticket-assistant.tsx renders it): worked out here so the
// check script can read it without rendering. Nothing here calls the model: it reads this company's log for the ticket
// (by shopId) and builds the "What we'll send" previews with the same builders the actions use.
import { db } from "@/lib/db";
import { fmtDateTime } from "@/lib/format";
import { gateFor, type Gate } from "@/lib/module-gate";
import { shopTimeZone } from "@/lib/shop-zone";
import { causeSources, ticketContext, voiceFor } from "./context";
import { type FeatureId } from "./features";
import { buildCustomerMessage, buildLikelyCauses, buildPartnerNote, buildWriteUp, parseCauses, type Built, type Cause, type Source } from "./prompts";
import { entryFor, type Entry } from "./ui";

export type Latest = { id: string; text: string; accepted: boolean | null } | null;

export type TicketAssistantView = {
  gate: Gate;
  /** The Ask / Draft buttons work (module on and the ticket can be worked on); else only the log shows. */
  buttons: boolean;
  drafts: Entry;
  causes: Entry;
  latest: Record<"draft_work_done" | "draft_diagnosis" | "draft_partner_note" | "draft_estimate" | "draft_ready", Latest>;
  /** "What we'll send" until the feature has been used on this ticket. */
  previews: Partial<Record<FeatureId, string>>;
  latestCauses: { id: string; causes: Cause[] | null; raw: string; accepted: boolean | null; at: string } | null;
  history: { id: string; feature: string; at: string; accepted: boolean | null }[];
};

const preview = (b: Built) => `${b.system}\n\n---\n\n${b.messages.map((m) => m.content).join("\n\n")}`;

/** Null for a ticket that isn't this company's, or a company with the module off and nothing logged. */
export async function ticketAssistantView(o: { shopId: string; ticketId: string; canWork: boolean }): Promise<TicketAssistantView | null> {
  const { shopId, ticketId } = o;
  const gate = await gateFor(shopId, "assistant");
  if (gate === "hidden") return null;
  if (!(await db.ticket.findFirst({ where: { id: ticketId, shopId }, select: { id: true } }))) return null;
  const [tz, calls] = await Promise.all([shopTimeZone(shopId), db.assistantCall.findMany({ where: { shopId, ticketId }, orderBy: { createdAt: "desc" }, take: 40 })]);
  const buttons = gate === "on" && o.canWork;
  const none: Entry = { show: false };
  const [drafts, causes] = buttons ? await Promise.all([entryFor(shopId, "draft"), entryFor(shopId, "causes")]) : [none, none];

  const done = calls.filter((c) => !c.error);
  const latestOf = (f: FeatureId): Latest => {
    const c = done.find((x) => x.feature === f);
    return c ? { id: c.id, text: c.response, accepted: c.accepted } : null;
  };
  const firstUse = (f: FeatureId) => !done.some((c) => c.feature === f);

  const previews: TicketAssistantView["previews"] = {};
  if (buttons && (drafts.show || causes.show)) {
    const ctx = await ticketContext(shopId, ticketId);
    const voice = await voiceFor(shopId);
    const opts = { firstName: ctx.firstName, totalCents: ctx.totalCents };
    if (drafts.show) {
      if (firstUse("draft_work_done")) previews.draft_work_done = preview(buildWriteUp("work_done", ctx.facts, voice, ctx.redaction, opts));
      if (firstUse("draft_diagnosis")) previews.draft_diagnosis = preview(buildWriteUp("diagnosis", ctx.facts, voice, ctx.redaction, opts));
      if (firstUse("draft_partner_note")) previews.draft_partner_note = preview(buildPartnerNote(ctx.facts, null, voice, ctx.redaction, opts));
      if (firstUse("draft_estimate")) previews.draft_estimate = preview(buildCustomerMessage("estimate", ctx.facts, voice, ctx.redaction, opts));
      if (firstUse("draft_ready")) previews.draft_ready = preview(buildCustomerMessage("ready", ctx.facts, voice, ctx.redaction, opts));
    }
    if (causes.show && firstUse("likely_causes")) previews.likely_causes = preview(buildLikelyCauses(ctx.facts, await causeSources(shopId, ctx), ctx.redaction));
  }

  const lc = done.find((c) => c.feature === "likely_causes") ?? null;
  return {
    gate,
    buttons,
    drafts,
    causes,
    latest: {
      draft_work_done: latestOf("draft_work_done"),
      draft_diagnosis: latestOf("draft_diagnosis"),
      draft_partner_note: latestOf("draft_partner_note"),
      draft_estimate: latestOf("draft_estimate"),
      draft_ready: latestOf("draft_ready"),
    },
    previews,
    latestCauses: lc ? { id: lc.id, causes: parseCauses(lc.response, (lc.sources as Source[] | null) ?? []), raw: lc.response, accepted: lc.accepted, at: fmtDateTime(lc.createdAt, tz, { month: "short", day: "numeric" }) } : null,
    history: done.slice(0, 8).map((c) => ({ id: c.id, feature: c.feature, at: fmtDateTime(c.createdAt, tz, { month: "short", day: "numeric" }), accepted: c.accepted })),
  };
}
