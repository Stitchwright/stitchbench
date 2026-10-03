// The online shop's forms (online-and-parts-design.md section 3): a line added to or set in the cart (the cart lives
// in the address, so every answer is a 303 back to a page with the new one), and checkout, which makes the order and
// sends the customer to Stripe's payment page. No session: the slug names the shop. Rate-limited per address and per
// shop; a filled honeypot or a checkout sent within five seconds of opening the page is dropped quietly.
import { isUserError } from "@/lib/user-error";
import type { OnlineCustomer } from "@/lib/online-booking";
import { allow, allowPublic } from "@/lib/rate-limit";
import { formUpTo } from "@/lib/read-body";
import { cartWith, encodeCart, fulfilOf, parseCart, startCheckout } from "@/lib/shop/online-shop";

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" };
const MIN_FILL_MS = 5_000;
const see = (to: string) => new Response(null, { status: 303, headers: { ...HEADERS, Location: to } });
const text = (fd: FormData, k: string, max = 500) => (typeof fd.get(k) === "string" ? (fd.get(k) as string).trim().slice(0, max) : "");

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const home = `/shop/${encodeURIComponent(slug)}`;
  if (!allowPublic(req, "shop", 120, 10 * 60_000) || !allow(`shop:${slug}`, 600, 60 * 60_000)) {
    return new Response("Too many requests. Please try again in a few minutes, or call the shop.", { status: 429, headers: HEADERS });
  }
  const fd = await formUpTo(req, 16 * 1024);
  if (!fd || fd === "too large") return see(home);
  const action = text(fd, "action", 20);
  const cart = parseCart(text(fd, "c", 2000));
  const cartHref = (c: string, extra = "") => `${home}/cart?c=${encodeURIComponent(c)}${extra}`;
  try {
    if (action === "add" || action === "set") {
      const partId = text(fd, "partId", 40);
      const qty = Number(text(fd, "qty", 10) || "1");
      const next = cartWith(cart, partId, action === "add" ? (cart.get(partId) ?? 0) + qty : qty);
      return see(cartHref(encodeCart(next), action === "add" ? "&added=1" : ""));
    }
    if (action !== "checkout") return see(home);
    if (!allowPublic(req, "shop-checkout", 10, 10 * 60_000) || !allow(`shop-checkout:${slug}`, 100, 60 * 60_000)) {
      return new Response("Too many requests. Please try again in a few minutes, or call the shop.", { status: 429, headers: HEADERS });
    }
    // Bots: the hidden field filled, or the form sent within five seconds of opening.
    const t0 = Number(text(fd, "t0", 20));
    if (text(fd, "website") || !Number.isFinite(t0) || Date.now() - t0 < MIN_FILL_MS) return see(home);
    const customer: OnlineCustomer = { name: text(fd, "name", 120), phone: text(fd, "phone", 40) || null, email: text(fd, "email", 120) || null, notify: text(fd, "notify", 10) };
    const fulfil = fulfilOf(text(fd, "fulfil", 10));
    const r = await startCheckout({ slug, cart, customer, fulfil, address: text(fd, "address", 400) || null, note: text(fd, "note", 500) || null });
    return see(r.url);
  } catch (e) {
    const f = text(fd, "fulfil", 10) === "ship" ? "&f=ship" : "";
    if (isUserError(e)) return see(cartHref(encodeCart(cart), `${f}&err=${encodeURIComponent(e.message)}`));
    console.error("online shop:", e instanceof Error ? e.message : e);
    return see(cartHref(encodeCart(cart), `${f}&err=${encodeURIComponent("Something went wrong on our side. Please try again, or call the shop.")}`));
  }
}
