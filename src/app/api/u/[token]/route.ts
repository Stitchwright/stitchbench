// Unsubscribe from marketing email (scheduling-messaging-design.md section 9.6). Public: no session, no module check
// (CAN-SPAM: opting out must keep working after the last send, whatever the shop's modules say).
//   POST  the button on /u/{token} (form post) or a mail program's one-click (RFC 8058: body List-Unsubscribe=One-Click)
//   GET   -> back to the page; a GET never unsubscribes (link scanners open links)
import { db } from "@/lib/db";
import { suppress } from "@/lib/messaging/consent";
import { allowPublic } from "@/lib/rate-limit";
import { readUpTo } from "@/lib/read-body";

const TOKEN = /^[A-Za-z0-9_-]{22}$/;

const see = (path: string) => new Response(null, { status: 303, headers: { location: path } });

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return see(`/u/${encodeURIComponent(token)}`);
}

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  if (!allowPublic(req, "u-post", 20, 60_000)) return new Response("Too many requests. Try again in a minute.", { status: 429 });
  const { token } = await params;
  if (!TOKEN.test(token)) return see(`/u/${encodeURIComponent(token)}`);
  const row = await db.outMessage.findFirst({ where: { optOutToken: token }, select: { shopId: true, address: true, customerId: true } });
  if (!row) return see(`/u/${token}`);

  const already = await db.suppression.findUnique({ where: { shopId_channel_address: { shopId: row.shopId, channel: "email", address: row.address } }, select: { scope: true } });
  if (!already) {
    try {
      await db.$transaction((tx) => suppress(tx, { shopId: row.shopId, channel: "email", address: row.address, scope: "marketing", source: "unsubscribe_link", customerId: row.customerId }));
    } catch (e) {
      // Two clicks at once: the other one wrote it (unique on shop + channel + address).
      if ((e as { code?: string }).code !== "P2002") throw e;
    }
  }

  const body = await readUpTo(req, 4096);
  const oneClick = !!body && new URLSearchParams(new TextDecoder().decode(body)).get("List-Unsubscribe") === "One-Click";
  return oneClick ? new Response("Unsubscribed.", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }) : see(`/u/${token}?done=1`);
}
