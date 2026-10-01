// Vac Shop home. Foundation stub (owner: vac-repair): the gate, the tabs, and "More in this update."
import { requireUser } from "@/lib/session";
import { Empty } from "@/components/ui";
import { VacFrame, vacPageState } from "@/components/vac/vac-page";

export default async function VacHome() {
  const user = await requireUser();
  const s = await vacPageState(user);
  return (
    <VacFrame title="Vac Shop" tab={null} needsRegister {...s}>
      <Empty>More in this update.</Empty>
    </VacFrame>
  );
}
