// Customer answers on the shop's public page (shop-features-round-2-design.md 5.6): the four buttons, a typed question
// and "leave your question". No session: the slug names the shop; JSON in, { answer, ... } out. Off (404) unless the
// shop turned answers on. Rate-limited per address and per shop; a ticket lookup has its own, tighter limit.
import { isUserError } from "@/lib/user-error";
import { answersShop, classesAnswer, dropoffAnswer, hoursAnswer, leaveQuestion, statusAnswer, typedQuestion } from "@/lib/customer-answers";
import { allow, allowPublic } from "@/lib/rate-limit";
import { readUpTo } from "@/lib/read-body";

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex", "content-type": "application/json" };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: HEADERS });

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!allowPublic(req, "ask", 30, 10 * 60_000) || !allow(`ask-shop:${slug}`, 400, 60 * 60_000)) return json(429, { error: "Too many questions. Please try again in a few minutes, or call the shop." });
  const shop = await answersShop(slug);
  if (!shop?.on) return json(404, { error: "Questions aren't answered here." });
  const raw = await readUpTo(req, 8 * 1024);
  let body: Record<string, unknown> = {};
  try {
    body = raw ? (JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>) : {};
  } catch {
    return json(400, { error: "Something went wrong. Please try again." });
  }
  if (typeof body.website === "string" && body.website) return json(200, { answer: "Thanks." }); // a bot filled the hidden field
  try {
    switch (body.kind) {
      case "status":
        if (!allowPublic(req, "ask-status", 10, 10 * 60_000)) return json(429, { error: "Too many tries. Please wait a few minutes, or call the shop." });
        return json(200, await statusAnswer(shop, body.ticket, body.last4));
      case "hours":
        return json(200, { answer: hoursAnswer(shop) });
      case "classes":
        return json(200, await classesAnswer(shop));
      case "dropoff":
        return json(200, await dropoffAnswer(shop));
      case "typed":
        return json(200, await typedQuestion(shop, String(body.text ?? "")));
      case "leave":
        return json(200, { answer: await leaveQuestion(shop, { name: body.name, contact: body.contact, text: body.text }) });
      default:
        return json(400, { error: "Pick a question." });
    }
  } catch (e) {
    if (isUserError(e)) return json(400, { error: e.message });
    console.error("customer answers:", e instanceof Error ? e.message : e);
    return json(500, { error: "Something went wrong on our side. Please try again, or call the shop." });
  }
}
