// The customer's answer to an estimate (scheduling-messaging-design.md 10.4): a POST from the page's confirm step. No
// session and no module check for an existing link; the token is the only power it carries.
import { allowPublic } from "@/lib/rate-limit";
import { clientAddress } from "@/lib/client-ip";
import { answerByToken } from "@/lib/estimate-links";
import { cleanText } from "@/lib/messaging/templates";

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" };

/** 303 to the page: relative, because the address this server sees may not be the one the customer used. */
const back = (token: string, query = "") => new Response(null, { status: 303, headers: { ...HEADERS, Location: `/e/${encodeURIComponent(token)}${query}` } });

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!allowPublic(req, "e-post", 10, 60_000)) return new Response("Too many tries. Please wait a minute.", { status: 429, headers: HEADERS });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return back(token);
  }
  const answer = form.get("answer");
  if (answer !== "APPROVED" && answer !== "DECLINED") return back(token);
  // Without the confirm step nothing is answered: back to the page's confirm step instead.
  if (form.get("confirm") !== "1") return back(token, `?step=${answer === "APPROVED" ? "approve" : "decline"}`);
  const note = cleanText(typeof form.get("note") === "string" ? (form.get("note") as string) : "", 500) || null;
  const from = `${clientAddress(req) ?? "address not known"} · ${(req.headers.get("user-agent") ?? "").slice(0, 200)}`;
  await answerByToken(token, answer, note, from);
  return back(token);
}
