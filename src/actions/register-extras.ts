"use server";

// What the register shows when a customer is chosen (shop-features-round-2-design.md section 1): her special orders
// waiting at the counter, and (as their packages add them) her price group, birthday offer, trade-up credit and
// rentals. One read for the register's quiet lines; nothing here writes.
import { requireUser } from "@/lib/session";
import { customerExtrasFor, type CustomerExtras } from "@/lib/register-extras";

export async function customerExtras(customerId: string | null): Promise<CustomerExtras | null> {
  const user = await requireUser();
  if (!customerId) return null;
  return customerExtrasFor(user.shopId, String(customerId));
}
