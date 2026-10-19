import "server-only";
// What an Assistant request is made from (ai-assistant-scope.md 1.1 and 1.2): one ticket, read by shopId, with no
// customer field in it, and for "What's likely wrong" the sources: this shop's past tickets on the model, its gotcha
// notes, the community's posts for the model, the factory specs, settings and service modes. Every query filters by the
// signed-in company; a ticket of another company is "not found".
import { db } from "@/lib/db";
import { modelKey, ticketNo } from "@/lib/format";
import { sameText } from "@/lib/input";
import { kindOf } from "@/lib/equipment/shop";
import { gRange, lookupModel, notesFor, settingsFor, specsFor } from "@/lib/model-info";
import { ticketTotals } from "@/lib/ticket-math";
import { UserError } from "@/lib/user-error";
import { namesToBlank, type Redaction } from "./redact";
import type { CauseSource, TicketFacts, Voice } from "./prompts";

/** The model page's address (the same as modelHref in the components, which a library file doesn't import). */
const modelPage = (brand: string, model: string, kind?: string | null) => {
  const base = `/models/${encodeURIComponent(brand)}/${encodeURIComponent(model)}`;
  return kind && kind !== "sewing" ? `${base}?kind=${encodeURIComponent(kind)}` : base;
};

export type TicketContext = {
  facts: TicketFacts;
  redaction: Redaction;
  /** The ids of what this is about, for the log. */
  ids: { ticketId: string; machineId: string };
  machine: { brand: string; model: string; modelKey: string; kind: string; serial: string | null };
  /** The customer's first name, only when the company chose to offer first names; else null and drafts carry {first_name}. */
  firstName: string | null;
  totalCents: number;
};

export async function assistantSettings(shopId: string) {
  return (
    (await db.assistantSettings.findUnique({ where: { shopId } })) ?? { shopId, draftOn: true, causesOn: true, plateOn: true, manualsOn: true, partsOn: true, fabricOn: true, stockOn: true, askOn: true, marketingOn: true, quiltOn: true, customerOn: false, customerDailyCap: 20, offerFirstNames: false, voice: null as string | null, aiSource: "foundry", ownKey: null as string | null, updatedAt: new Date(0) }
  );
}

export async function voiceFor(shopId: string): Promise<Voice> {
  const [shop, s] = await Promise.all([db.shop.findUnique({ where: { id: shopId }, select: { name: true } }), assistantSettings(shopId)]);
  return { shopName: shop?.name ?? "the shop", sample: s.voice };
}

/** The ticket as the Assistant may see it, or a UserError for one that isn't this company's. */
export async function ticketContext(shopId: string, ticketId: string): Promise<TicketContext> {
  const t = await db.ticket.findFirst({
    where: { id: ticketId, shopId },
    include: { machine: true, lines: { orderBy: { createdAt: "asc" } }, customer: { select: { name: true } }, viaAccount: { select: { name: true } } },
  });
  if (!t) throw new UserError("Ticket not found.");
  const [kind, everyone, settings] = await Promise.all([
    kindOf(shopId, t.machine),
    db.customer.findMany({ where: { shopId }, select: { name: true }, take: 5000 }),
    assistantSettings(shopId),
  ]);
  const totals = ticketTotals(t.lines, [], t.taxRatePct);
  return {
    facts: {
      number: t.number,
      noun: kind.noun,
      brand: t.machine.brand,
      model: t.machine.model,
      machineType: t.machine.machineType,
      serviceRequested: t.serviceRequested,
      problem: t.problem,
      diagnosis: t.diagnosis,
      workDone: t.workDone,
      notes: t.notes,
      accessories: t.accessories,
      lines: t.lines.map((l) => ({ kind: l.kind, description: l.description, qty: l.qty, unitPriceCents: l.unitPriceCents })),
    },
    redaction: { names: namesToBlank({ customer: t.customer?.name, account: t.viaAccount?.name, allCustomers: everyone.map((c) => c.name) }), serials: t.machine.serial ? [t.machine.serial] : [] },
    ids: { ticketId: t.id, machineId: t.machineId },
    machine: { brand: t.machine.brand, model: t.machine.model, modelKey: t.machine.modelKey, kind: t.machine.kind, serial: t.machine.serial },
    firstName: settings.offerFirstNames && t.customer?.name ? (t.customer.name.trim().split(/\s+/)[0] ?? null) : null,
    totalCents: totals.total,
  };
}

const CLOSED_TICKETS = 20;

/**
 * The numbered sources for "What's likely wrong". Each carries a reference the model must cite; unknown citations
 * become "general knowledge" when the answer is read. Customer fields are never selected; part lines are described by
 * their text only, and the free text still goes through redact() when the request is built.
 */
export async function causeSources(shopId: string, ctx: TicketContext): Promise<CauseSource[]> {
  const { brand, model } = ctx.machine;
  const key = modelKey(model);
  const here = modelPage(brand, model, ctx.machine.kind);
  const out: CauseSource[] = [];

  // This shop's last closed tickets on the same make and model (not this one).
  const past = await db.ticket.findMany({
    where: { shopId, id: { not: ctx.ids.ticketId }, closedAt: { not: null }, machine: { brand: sameText(brand), modelKey: key } },
    orderBy: { closedAt: "desc" },
    take: CLOSED_TICKETS,
    select: {
      id: true,
      number: true,
      intakeAt: true,
      problem: true,
      diagnosis: true,
      workDone: true,
      lines: { where: { kind: { in: ["PART", "SERVICE"] } }, select: { kind: true, description: true }, take: 10 },
    },
  });
  for (const p of past) {
    const text = [p.problem && `problem: ${p.problem}`, p.diagnosis && `found: ${p.diagnosis}`, p.workDone && `done: ${p.workDone}`, p.lines.length && `lines: ${p.lines.map((l) => l.description).join("; ")}`].filter(Boolean).join(" | ");
    if (text) out.push({ kind: "ticket", ref: `ticket:${ticketNo(p.number)}`, label: `This shop's ticket #${ticketNo(p.number)}`, text, href: `/tickets/${p.id}` });
  }

  // The shop's gotcha notes, the community's posts, specs, settings, service modes for the model.
  const [notes, posts, specs, settings, modes] = await Promise.all([
    notesFor(shopId, brand, model),
    db.hubPost.findMany({ where: { modelKey: key }, orderBy: { createdAt: "desc" }, take: 8, select: { id: true, title: true, body: true, kind: true } }),
    specsFor(brand, model),
    settingsFor(brand, model),
    lookupModel(
      model,
      (f) => db.serviceMode.findMany({ where: { modelKeys: f } }),
      (rows) => rows,
    ),
  ]);
  for (const n of notes.slice(0, 8)) out.push({ kind: "gotcha", ref: `gotcha:${n.id}`, label: `This shop's ${n.kind.toLowerCase()} note`, text: n.body, href: here });
  for (const p of posts) out.push({ kind: "hubpost", ref: `hubpost:${p.id}`, label: `Community ${p.kind.toLowerCase()}: ${p.title}`, text: p.body, href: here });
  for (const s of specs.slice(0, 4)) {
    const text = [s.upperMinG != null && `upper tension ${gRange(s.upperMinG, s.upperMaxG)}`, s.bobbinMinG != null && `bobbin tension ${gRange(s.bobbinMinG, s.bobbinMaxG)}`, s.upperText, s.bobbinText, s.otherSpecs].filter(Boolean).join("; ");
    if (text) out.push({ kind: "spec", ref: `spec:${s.id}`, label: `Factory tension spec (${s.models})`, text, href: "/specs" });
  }
  for (const s of settings.slice(0, 8)) {
    const range = s.valueMin != null ? (s.valueMax != null && s.valueMax !== s.valueMin ? `${s.valueMin}-${s.valueMax}` : `${s.valueMin}`) : (s.valueText ?? "");
    out.push({ kind: "setting", ref: `setting:${s.id}`, label: `Factory setting: ${s.label}`, text: `${range} ${s.unit ?? ""}${s.conditions ? `; ${s.conditions}` : ""}`.trim(), href: here });
  }
  for (const m of modes.rows.slice(0, 3)) {
    out.push({ kind: "servicemode", ref: `servicemode:${m.id}`, label: `Service mode: ${m.mode}`, text: `enter: ${m.enterSteps.join(" ")}${m.cautions ? ` | caution: ${m.cautions}` : ""}`.slice(0, 600), href: here });
  }
  return out;
}
