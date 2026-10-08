// The print page moved with the orders (see ../page.tsx).
import { redirect } from "next/navigation";

export default async function OldOrderPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/parts/orders/${encodeURIComponent(id)}/print`);
}
