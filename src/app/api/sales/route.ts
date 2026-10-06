import { sessionUser } from "@/lib/session";
import { csvResponse } from "@/lib/csv";
import { paymentsBetween } from "@/lib/sales";
import { dateIn, monthRange } from "@/lib/time-zone";
import { shopTimeZone } from "@/lib/shop-zone";
import { db } from "@/lib/db";
import { actorOf, audit } from "@/lib/audit";
import { PAYMENT_LABEL } from "@/lib/constants";

export async function GET(req: Request) {
  const user = await sessionUser();
  if (!user) return new Response("Sign in first.", { status: 401 });
  const shopId = user.shopId;
  const url = new URL(req.url);
  const tz = await shopTimeZone(shopId);
  const { start, end, fromStr, toStr } = monthRange(url.searchParams.get("from") ?? undefined, url.searchParams.get("to") ?? undefined, tz);
  const rows = await paymentsBetween(shopId, start, end);
  await audit(db, actorOf(user), { action: "export.download", subjectType: "Export", subjectLabel: `sales ${fromStr} to ${toStr}` });
  return csvResponse(
    [
      ["date", "ticket", "customer", "via_account", "brand", "model", "serial", "method", "amount", "note"],
      ...rows.map((p) => [
        // The shop's calendar day, the same one the range above was cut on (the server's UTC day can be tomorrow).
        dateIn(p.paidAt, tz),
        p.ticket.number,
        p.ticket.customer?.name,
        p.ticket.viaAccount?.code ?? p.ticket.viaAccount?.name,
        p.ticket.machine.brand,
        p.ticket.machine.model,
        p.ticket.machine.serial,
        PAYMENT_LABEL[p.method],
        (p.amountCents / 100).toFixed(2),
        p.note,
      ]),
    ],
    `sales_${fromStr}_to_${toStr}.csv`,
  );
}
