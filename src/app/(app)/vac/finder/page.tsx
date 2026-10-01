// The bag / belt / filter finder. Foundation stub (owner: vac-finder).
import { requireUser } from "@/lib/session";
import { Empty } from "@/components/ui";
import { VacFrame, vacPageState } from "@/components/vac/vac-page";

export default async function VacFinder() {
  const user = await requireUser();
  const s = await vacPageState(user);
  return (
    <VacFrame title="Bag, belt and filter finder" tab="finder" needsRegister {...s}>
      <Empty>Coming in this update.</Empty>
    </VacFrame>
  );
}
