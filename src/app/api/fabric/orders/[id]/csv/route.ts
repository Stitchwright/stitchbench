// A purchase order as a spreadsheet (fabric-smarts-design.md section 5): the maker's item numbers, amounts and costs, for
// the rep or the wholesaler's cart upload. Only the signed-in company's own order; nothing is sent from here.
import { sessionUser } from "@/lib/session";
import { csvResponse } from "@/lib/csv";
import { orderCsvRows, orderFor } from "@/lib/fabric-orders";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await sessionUser();
  if (!user) return new Response("Sign in first.", { status: 401 });
  const { id } = await params;
  const o = await orderFor(user.shopId, id);
  if (!o) return new Response("Order not found.", { status: 404 });
  const who = o.supplier.name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "supplier";
  return csvResponse(orderCsvRows(o), `order-${o.number}-${who}.csv`);
}
