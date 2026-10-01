// "Bags due" call list. Foundation stub (owner: vac-bags-due).
import { requireUser } from "@/lib/session";
import { Empty } from "@/components/ui";
import { VacFrame, vacPageState } from "@/components/vac/vac-page";

export default async function BagsDue() {
  const user = await requireUser();
  const s = await vacPageState(user);
  return (
    <VacFrame title="Bags due" tab="bags-due" {...s}>
      <Empty>Coming in this update.</Empty>
    </VacFrame>
  );
}
