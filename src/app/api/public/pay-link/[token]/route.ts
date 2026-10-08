// A pay link's Pay button (shop-features-round-2-design.md 1.3): the open Stripe page for the link, or a new one, then a
// 303 there. Under /api/public/ so the public links gate and the server's links-host lock let its POST through (it was
// under /shop/o/, where only GETs pass). No session: the token in the address is the key. Rate-limited per address; a problem goes back to the
// link's page with the words.
import { isUserError } from "@/lib/user-error";
import { allowPublic } from "@/lib/rate-limit";
import { openPayLink } from "@/lib/pay-links";

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" };
const see = (to: string) => new Response(null, { status: 303, headers: { ...HEADERS, Location: to } });

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const back = `/shop/o/${encodeURIComponent(token)}`;
  if (!allowPublic(req, "shop-paylink", 20, 10 * 60_000, "shop")) return new Response("Too many requests. Please try again in a few minutes, or call the shop.", { status: 429, headers: HEADERS });
  try {
    return see(await openPayLink(token));
  } catch (e) {
    if (isUserError(e)) return see(`${back}?err=${encodeURIComponent(e.message)}`);
    console.error("pay link:", e instanceof Error ? e.message : e);
    return see(`${back}?err=${encodeURIComponent("Something went wrong on our side. Please try again, or call the shop.")}`);
  }
}
