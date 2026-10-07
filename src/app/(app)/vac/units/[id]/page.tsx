// A unit's old Vac Shop address: the same unit under Machines for sale (tax-machine-sales-layaway-design.md section 3).
import { permanentRedirect } from "next/navigation";

export default async function OldVacUnit({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  permanentRedirect(`/units/${encodeURIComponent(id)}`);
}
