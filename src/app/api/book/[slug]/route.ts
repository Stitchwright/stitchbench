// A customer's booking or class sign-up from /book/{slug} (online-and-parts-design.md section 2). No session: the slug
// names the shop and the form carries the rest. Rate-limited per address and per shop; a filled honeypot or a form
// submitted within five seconds of opening is dropped quietly. Always a 303 back to a page that says what happened.
import { isUserError } from "@/lib/action";
import { bookOnline, signUpOnline, type OnlineCustomer } from "@/lib/online-booking";
import { allowPublic, allow } from "@/lib/rate-limit";
import { formUpTo } from "@/lib/read-body";

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" };
const MIN_FILL_MS = 5_000;

const see = (path: string) => new Response(null, { status: 303, headers: { ...HEADERS, Location: path } });
const text = (fd: FormData, k: string, max = 500) => (typeof fd.get(k) === "string" ? (fd.get(k) as string).trim().slice(0, max) : "");

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const home = `/book/${encodeURIComponent(slug)}`;
  if (!allowPublic(req, "book", 10, 10 * 60_000) || !allow(`book-shop:${slug}`, 60, 60 * 60_000)) {
    return new Response("Too many requests. Please try again in a few minutes, or call the shop.", { status: 429, headers: HEADERS });
  }
  const fd = await formUpTo(req, 16 * 1024);
  if (!fd || fd === "too large") return see(home);
  const backRaw = text(fd, "back", 300);
  const back = backRaw.startsWith("/book/") && !backRaw.includes("//") ? backRaw.split("?")[0] : home;
  const oops = (msg: string) => see(`${back}?err=${encodeURIComponent(msg)}${text(fd, "at") ? `&at=${encodeURIComponent(text(fd, "at", 40))}` : ""}`);
  // Bots: the hidden field filled, or the form sent within five seconds of opening.
  const t0 = Number(text(fd, "t0", 20));
  if (text(fd, "website") || !Number.isFinite(t0) || Date.now() - t0 < MIN_FILL_MS) return see(home);
  const customer: OnlineCustomer = { name: text(fd, "name", 120), phone: text(fd, "phone", 40) || null, email: text(fd, "email", 120) || null, notify: text(fd, "notify", 10) };
  const note = text(fd, "note", 500) || null;
  try {
    if (text(fd, "kind", 20) === "class") {
      const r = await signUpOnline({ slug, classId: text(fd, "classId", 40), customer, attendee: text(fd, "attendee", 80) || null, note });
      return see(`/book/m/${r.token}?new=1`);
    }
    const at = new Date(text(fd, "at", 40));
    const r = await bookOnline({ slug, typeId: text(fd, "typeId", 40), startsAt: at, customer, note });
    return see(`/book/m/${r.token}?new=1`);
  } catch (e) {
    if (isUserError(e)) return oops(e.message);
    console.error("online booking:", e instanceof Error ? e.message : e);
    return oops("Something went wrong on our side. Please try again, or call the shop.");
  }
}
