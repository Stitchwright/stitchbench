// The status link for an outside phone-answering service (shop-features-round-2-design.md 5.6): the same four answers
// as the booking page's buttons (ticket status by number and phone, hours, classes with seats, open drop-off times) and
// booking a drop-off, with the shop's private key ("Authorization: Bearer sbk_..."). Nothing else is reachable here, no
// Assistant is used and no call is counted. Rate-limited per address and per shop; a wrong key or no key is a 401.
//   GET  /api/public/v1/{slug}/status?ticket=1234&phone=5551231234   (the last four digits are enough)
//   GET  /api/public/v1/{slug}/hours | /classes | /dropoff
//   POST /api/public/v1/{slug}/book  { "typeId", "startsAt" (ISO), "name", "phone", "note"? }
import { isUserError } from "@/lib/user-error";
import { classesAnswer, dropoffAnswer, hoursAnswer, shopForKey, statusAnswer } from "@/lib/customer-answers";
import { bookOnline } from "@/lib/online-booking";
import { allow, allowPublic } from "@/lib/rate-limit";
import { readUpTo } from "@/lib/read-body";

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex", "content-type": "application/json" };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: HEADERS });
type Ctx = { params: Promise<{ slug: string; what: string }> };

const keyOf = (req: Request) => /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? null;

async function gate(req: Request, slug: string) {
  if (!allowPublic(req, "status-api", 120, 60_000) || !allow(`status-api:${slug}`, 2000, 60 * 60_000)) return { res: json(429, { error: "Too many requests. Try again in a minute." }) };
  const shop = await shopForKey(slug, keyOf(req));
  if (!shop) return { res: json(401, { error: "This link needs the shop's key (Authorization: Bearer <key>)." }) };
  return { shop };
}

export async function GET(req: Request, { params }: Ctx) {
  const { slug, what } = await params;
  const g = await gate(req, slug);
  if (!g.shop) return g.res;
  const shop = g.shop;
  const url = new URL(req.url);
  switch (what) {
    case "status":
      if (!allow(`status-api-ticket:${slug}`, 300, 60 * 60_000)) return json(429, { error: "Too many ticket lookups this hour." });
      return json(200, await statusAnswer(shop, url.searchParams.get("ticket"), url.searchParams.get("phone")));
    case "hours":
      return json(200, { answer: hoursAnswer(shop) });
    case "classes":
      return json(200, await classesAnswer(shop));
    case "dropoff":
      return json(200, await dropoffAnswer(shop));
    default:
      return json(404, { error: "Ask for status, hours, classes or dropoff." });
  }
}

export async function POST(req: Request, { params }: Ctx) {
  const { slug, what } = await params;
  const g = await gate(req, slug);
  if (!g.shop) return g.res;
  if (what !== "book") return json(404, { error: "Only book takes a POST." });
  const raw = await readUpTo(req, 8 * 1024);
  let b: Record<string, unknown>;
  try {
    b = raw ? (JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>) : {};
  } catch {
    return json(400, { error: "Send JSON." });
  }
  const s = (k: string, max: number) => (typeof b[k] === "string" ? (b[k] as string).trim().slice(0, max) : "");
  try {
    const r = await bookOnline({ slug, typeId: s("typeId", 40), startsAt: new Date(s("startsAt", 40)), customer: { name: s("name", 120), phone: s("phone", 40) || null, email: null, notify: "sms" }, note: s("note", 500) || "Booked by the phone-answering service" });
    return json(200, { answer: "Booked. The customer gets a confirmation.", appointmentId: r.appointmentId });
  } catch (e) {
    if (isUserError(e)) return json(400, { error: e.message });
    console.error("status link booking:", e instanceof Error ? e.message : e);
    return json(500, { error: "Something went wrong. Try again." });
  }
}
