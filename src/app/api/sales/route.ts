import { sessionUser } from "@/lib/session";
import { csvCell as csv } from "@/lib/csv";
import { db } from "@/lib/db";
import { monthRange, paymentsBetween } from "@/lib/sales";
import { PAYMENT_LABEL } from "@/lib/constants";

export async function GET(req: Request) {
  const user = await sessionUser();
  if (!user) return new Response("Sign in first.", { status: 401 });
  const shopId = user.shopId;
  const url = new URL(req.url);
  const tz = (await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { timeZone: true } })).timeZone;
  const { start, end, fromStr, toStr } = monthRange(url.searchParams.get("from") ?? undefined, url.searchParams.get("to") ?? undefined, tz);
  const rows = await paymentsBetween(shopId, start, end);
  const lines = [
    ["date", "ticket", "customer", "via_account", "brand", "model", "serial", "method", "amount", "note"].join(","),
    ...rows.map((p) =>
      [
        p.paidAt.toISOString().slice(0, 10),
        p.ticket.number,
        p.ticket.customer?.name,
        p.ticket.viaAccount?.code ?? p.ticket.viaAccount?.name,
        p.ticket.machine.brand,
        p.ticket.machine.model,
        p.ticket.machine.serial,
        PAYMENT_LABEL[p.method],
        (p.amountCents / 100).toFixed(2),
        p.note,
      ]
        .map(csv)
        .join(","),
    ),
  ];
  return new Response(lines.join("\n") + "\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="sales_${fromStr}_to_${toStr}.csv"`,
    },
  });
}
