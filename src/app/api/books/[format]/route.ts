// The bookkeeping export (later-round-1-design.md 3.4): one journal entry a day for a range, as QuickBooks Online's
// journal-entry CSV (format "csv") or QuickBooks Desktop's IIF (format "iif"). Owner or admin only; works while read-only.
import { db } from "@/lib/db";
import { sessionUser } from "@/lib/session";
import { csvResponse } from "@/lib/csv";
import { monthRange } from "@/lib/time-zone";
import { shopTimeZone } from "@/lib/shop-zone";
import { actorOf, audit } from "@/lib/audit";
import { buildBooks, loadBooks, toIif, toJournalCsvRows } from "@/lib/books";

export async function GET(req: Request, { params }: { params: Promise<{ format: string }> }) {
  const user = await sessionUser();
  if (!user) return new Response("Sign in first.", { status: 401 });
  if (user.role === "TECH") return new Response("Only the owner or an admin can download the bookkeeping export.", { status: 403 });
  const { format } = await params;
  if (format !== "csv" && format !== "iif") return new Response("Unknown format.", { status: 404 });
  const url = new URL(req.url);
  const tz = await shopTimeZone(user.shopId);
  const { start, end, fromStr, toStr } = monthRange(url.searchParams.get("from"), url.searchParams.get("to"), tz);
  const books = await loadBooks(user.shopId);
  const r = await buildBooks(user.shopId, tz, start, end, books);
  await audit(db, actorOf(user), { action: "export.download", subjectType: "Export", subjectLabel: `bookkeeping ${format} ${fromStr} to ${toStr}` });
  if (format === "csv") return csvResponse(toJournalCsvRows(r.days), `journal_${fromStr}_${toStr}.csv`);
  return new Response(toIif(r.days), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="journal_${fromStr}_${toStr}.iif"` },
  });
}
