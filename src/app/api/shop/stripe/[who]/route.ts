// Stripe's webhook (online-and-parts-design.md section 3): /api/shop/stripe/platform for the hosted service's own
// account, /api/shop/stripe/{shopId} for a shop's. The raw body is checked against the endpoint's signing secret
// before anything is read from it.
import { readUpTo } from "@/lib/read-body";
import { allowPublic } from "@/lib/rate-limit";
import { handleWebhook } from "@/lib/shop/online-shop";

const HEADERS = { "Cache-Control": "no-store" };

export async function POST(req: Request, { params }: { params: Promise<{ who: string }> }) {
  const { who } = await params;
  if (!allowPublic(req, "stripe-webhook", 600, 60_000, "webhook")) return new Response("Too many requests.", { status: 429, headers: HEADERS });
  const raw = await readUpTo(req, 256 * 1024);
  if (!raw) return new Response("Bad body.", { status: 400, headers: HEADERS });
  const r = await handleWebhook(who, Buffer.from(raw).toString("utf8"), req.headers.get("stripe-signature"));
  return new Response(r.body, { status: r.status, headers: HEADERS });
}
