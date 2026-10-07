import "server-only";
// The dashboard's and register's to-do lines for the round 2 selling features (shop-features-round-2-design.md section
// 1), each only when it applies: special orders here too long or not told, and (as their packages add them) loaners
// and rentals overdue, memberships ending, this month's birthdays. Plain words and a link; the lines are drawn by
// src/components/slots/todo-lines.tsx.
import { db } from "@/lib/db";
import { specialOrderCounts } from "@/lib/special-orders";
import { wantsHereUntold } from "@/lib/want-lists";
import { loanCounts } from "@/lib/loans";
import { birthdayOfferOf, monthName } from "@/lib/birthdays";
import { shopTimeZone } from "@/lib/shop-zone";
import { ymdOf } from "@/lib/zoned";

export type TodoLine = { key: string; href: string; text: string };

export async function shopTodos(shopId: string, now = new Date()): Promise<TodoLine[]> {
  const out: TodoLine[] = [];
  if (await db.specialOrder.count({ where: { shopId, status: "HERE" } })) {
    const c = await specialOrderCounts(shopId, now);
    if (c.call) out.push({ key: "so-call", href: "/special-orders?tab=here", text: `${c.call} special ${c.call === 1 ? "order is" : "orders are"} here and the customer hasn't been told: call ${c.call === 1 ? "her" : "them"}` });
    if (c.late) out.push({ key: "so-late", href: "/special-orders?tab=here", text: `${c.late} special ${c.late === 1 ? "order hasn't" : "orders haven't"} been picked up after ${c.days} days` });
  }
  // This month's birthdays, while the shop has a birthday offer (for a card or a campaign).
  if (await birthdayOfferOf(shopId)) {
    const month = Number(ymdOf(now, await shopTimeZone(shopId)).slice(5, 7));
    const n = await db.customer.count({ where: { shopId, birthMonth: month } });
    if (n) out.push({ key: "birthdays", href: "/customers/birthdays", text: `${n} ${n === 1 ? "customer has a birthday" : "customers have birthdays"} in ${monthName(month)}` });
  }
  // Loaners and demos out (1.7).
  const loans = await loanCounts(shopId);
  if (loans.overdue) out.push({ key: "loans", href: "/units/loans", text: `Out on loan: ${loans.out}, ${loans.overdue} overdue` });
  const wants = await wantsHereUntold(shopId);
  if (wants) out.push({ key: "want-here", href: "/want-lists", text: `${wants} want list ${wants === 1 ? "item is" : "items are"} here now: let ${wants === 1 ? "her" : "them"} know` });
  return out;
}
