import "server-only";
// The dashboard's and register's to-do lines for the round 2 selling features (shop-features-round-2-design.md section
// 1), each only when it applies: special orders here too long or not told, and (as their packages add them) loaners
// and rentals overdue, memberships ending, this month's birthdays. Plain words and a link; the lines are drawn by
// src/components/slots/todo-lines.tsx.
import { db } from "@/lib/db";
import { specialOrderCounts } from "@/lib/special-orders";

export type TodoLine = { key: string; href: string; text: string };

export async function shopTodos(shopId: string, now = new Date()): Promise<TodoLine[]> {
  const out: TodoLine[] = [];
  if (await db.specialOrder.count({ where: { shopId, status: "HERE" } })) {
    const c = await specialOrderCounts(shopId, now);
    if (c.call) out.push({ key: "so-call", href: "/special-orders?tab=here", text: `${c.call} special ${c.call === 1 ? "order is" : "orders are"} here and the customer hasn't been told: call ${c.call === 1 ? "her" : "them"}` });
    if (c.late) out.push({ key: "so-late", href: "/special-orders?tab=here", text: `${c.late} special ${c.late === 1 ? "order hasn't" : "orders haven't"} been picked up after ${c.days} days` });
  }
  return out;
}
