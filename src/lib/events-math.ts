// Retreats, trunk shows and other ticketed events (shop-features-round-2-design.md 4.5): the pure part. An event is a
// class with a kind, an early-bird price, a deposit and a balance due day, choices with prices (room, meals) and a door
// price. No "server-only", no database: the check script and the forms read it.

export const EVENT_KINDS = { CLASS: "Class", RETREAT: "Retreat", EVENT: "Trunk show, sew-in or event" } as const;
export type EventKind = keyof typeof EVENT_KINDS;
export const isEventKind = (s: unknown): s is EventKind => typeof s === "string" && s in EVENT_KINDS;

export type ChoiceOption = { label: string; cents: number };
export type EventChoice = { key: string; label: string; options: ChoiceOption[] };
/** The choices an event offers: rooms, meals, and whether to ask about dietary needs. */
export type EventChoices = { list: EventChoice[]; dietary: boolean };

const MAX_OPTIONS = 12;

/** "Single +120, Double, Shared +$40.50" -> options with their extra price in cents. Errors in words. */
export function parseOptions(text: string | null | undefined): ChoiceOption[] {
  const out: ChoiceOption[] = [];
  for (const raw of (text ?? "").split(/[,\n;]/)) {
    const t = raw.trim();
    if (!t) continue;
    const m = /^(.*?)\s*\+\s*\$?\s*(\d+(?:\.\d{1,2})?)\s*$/.exec(t);
    const label = (m ? m[1] : t).trim().slice(0, 60);
    if (!label) throw new Error(`"${t}": give each choice a name, like "Single +120".`);
    out.push({ label, cents: m ? Math.round(Number(m[2]) * 100) : 0 });
  }
  if (out.length > MAX_OPTIONS) throw new Error(`Up to ${MAX_OPTIONS} choices each.`);
  if (new Set(out.map((o) => o.label.toLowerCase())).size !== out.length) throw new Error("Each choice needs its own name.");
  return out;
}

/** The options back in the form's words: "Single +120, Double, Shared". */
export function optionsText(options: ChoiceOption[]): string {
  return options.map((o) => (o.cents ? `${o.label} +${o.cents % 100 ? (o.cents / 100).toFixed(2) : o.cents / 100}` : o.label)).join(", ");
}

/** The event's saved choices, read safely. */
export function choicesOf(j: unknown): EventChoices {
  const out: EventChoices = { list: [], dietary: false };
  if (!j || typeof j !== "object" || Array.isArray(j)) return out;
  const o = j as { list?: unknown; dietary?: unknown };
  out.dietary = o.dietary === true;
  if (Array.isArray(o.list)) {
    for (const c of o.list.slice(0, 6)) {
      if (!c || typeof c !== "object") continue;
      const cc = c as { key?: unknown; label?: unknown; options?: unknown };
      if (typeof cc.key !== "string" || typeof cc.label !== "string" || !Array.isArray(cc.options)) continue;
      const options = cc.options
        .filter((x): x is ChoiceOption => !!x && typeof (x as ChoiceOption).label === "string" && Number.isInteger((x as ChoiceOption).cents))
        .slice(0, MAX_OPTIONS);
      if (options.length) out.list.push({ key: cc.key, label: cc.label, options });
    }
  }
  return out;
}

/** The two choices the form offers (rooms and meals), from their text boxes. */
export function choicesFromText(a: { rooms?: string | null; meals?: string | null; dietary?: boolean }): EventChoices {
  const list: EventChoice[] = [];
  const rooms = parseOptions(a.rooms);
  if (rooms.length) list.push({ key: "room", label: "Room", options: rooms });
  const meals = parseOptions(a.meals);
  if (meals.length) list.push({ key: "meals", label: "Meals", options: meals });
  return { list, dietary: !!a.dietary };
}

export type Picked = Record<string, string>;

/** What she picked, checked against the choices (the first option when she didn't say), and what it adds. */
export function pickedChoices(ch: EventChoices, given: Record<string, string | null | undefined>): { picked: Picked; extraCents: number } {
  const picked: Picked = {};
  let extra = 0;
  for (const c of ch.list) {
    const want = (given[c.key] ?? "").trim().toLowerCase();
    const opt = c.options.find((o) => o.label.toLowerCase() === want) ?? c.options[0];
    picked[c.key] = opt.label;
    extra += opt.cents;
  }
  const diet = (given.dietary ?? "").trim().slice(0, 200);
  if (ch.dietary && diet) picked.dietary = diet;
  return { picked, extraCents: extra };
}

/** The price for someone signing up today (YYYY-MM-DD in the shop's zone): the early-bird price until its day. */
export function priceToday(c: { feeCents: number; earlyCents: number | null; earlyUntil: string | null }, todayYmd: string): { cents: number; early: boolean } {
  if (c.earlyCents != null && c.earlyUntil && todayYmd <= c.earlyUntil) return { cents: c.earlyCents, early: true };
  return { cents: c.feeCents, early: false };
}

/** The day the balance is due: `days` before the first day (YYYY-MM-DD). */
export function balanceDueYmd(firstYmd: string, days: number): string {
  const [y, m, d] = firstYmd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
}

/** What a sign-up has paid: the one-payment way (the register's class seat) plus event payments, less a refund. */
export function paidSoFar(e: { paidAt: Date | null; paidCents: number | null; refundedAt: Date | null }, payments: { amountCents: number; paidAt: Date | null; cancelledAt: Date | null }[]): number {
  const one = e.paidAt && !e.refundedAt ? (e.paidCents ?? 0) : 0;
  return one + payments.filter((p) => p.paidAt && !p.cancelledAt).reduce((a, p) => a + p.amountCents, 0);
}

/** What to ask for next: the deposit while nothing is paid, else the rest. */
export function nextAsk(a: { priceCents: number; paidCents: number; depositCents: number | null }): { kind: "DEPOSIT" | "BALANCE"; cents: number } | null {
  const owing = Math.max(0, a.priceCents - a.paidCents);
  if (owing <= 0) return null;
  if (a.paidCents === 0 && a.depositCents && a.depositCents < owing) return { kind: "DEPOSIT", cents: a.depositCents };
  return { kind: "BALANCE", cents: owing };
}

/** "Deposit (non-refundable): Fall Retreat for Jane" — the line on her receipt. */
export function paymentWords(kind: "DEPOSIT" | "BALANCE" | "PAYMENT" | "TICKET", title: string, who: string, refundable: boolean): string {
  const what = kind === "DEPOSIT" ? `Deposit${refundable ? "" : " (non-refundable)"}` : kind === "BALANCE" ? "Balance" : kind === "TICKET" ? "Ticket at the door" : "Payment";
  return `${what}: ${title} for ${who}`.slice(0, 200);
}
