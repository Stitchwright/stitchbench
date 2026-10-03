// The customer manages their own booking from the link in the confirmation (online-and-parts-design.md section 2):
// cancel it, or move an appointment to another offered time. The token is the only power the request carries.
import { isUserError } from "@/lib/user-error";
import { cancelByToken, moveByToken } from "@/lib/online-booking";
import { allowPublic } from "@/lib/rate-limit";
import { formUpTo } from "@/lib/read-body";

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" };
const see = (path: string) => new Response(null, { status: 303, headers: { ...HEADERS, Location: path } });

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const page = `/book/m/${encodeURIComponent(token)}`;
  if (!allowPublic(req, "book-m", 20, 10 * 60_000)) return new Response("Too many requests. Please wait a few minutes.", { status: 429, headers: HEADERS });
  const fd = await formUpTo(req, 4 * 1024);
  if (!fd || fd === "too large") return see(page);
  const action = fd.get("action");
  try {
    if (action === "cancel") {
      if (fd.get("confirm") !== "1") return see(`${page}?step=cancel`);
      await cancelByToken(token);
      return see(`${page}?done=cancelled`);
    }
    if (action === "move") {
      const at = new Date(String(fd.get("at") ?? ""));
      await moveByToken(token, at);
      return see(`${page}?done=moved`);
    }
    return see(page);
  } catch (e) {
    if (isUserError(e)) return see(`${page}?err=${encodeURIComponent(e.message)}`);
    console.error("online booking (manage):", e instanceof Error ? e.message : e);
    return see(`${page}?err=${encodeURIComponent("Something went wrong on our side. Please try again, or call the shop.")}`);
  }
}
