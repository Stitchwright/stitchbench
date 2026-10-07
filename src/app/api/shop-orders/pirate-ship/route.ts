// Online orders to ship as a Pirate Ship spreadsheet (shop-features-round-2-design.md 9.5): the signed-in company's own
// paid orders to post that have no tracking number yet. Upload it at pirateship.com (Import a spreadsheet), buy the
// labels there, and paste each tracking number back on the order.
import { sessionUser } from "@/lib/session";
import { csvResponse } from "@/lib/csv";
import { pirateShipFile } from "@/lib/ship-orders";
import { todayIn } from "@/lib/time-zone";
import { shopTimeZone } from "@/lib/shop-zone";

export async function GET() {
  const user = await sessionUser();
  if (!user) return new Response("Sign in first.", { status: 401 });
  const { rows } = await pirateShipFile(user.shopId);
  return csvResponse(rows, `pirate-ship-${todayIn(await shopTimeZone(user.shopId))}.csv`);
}
