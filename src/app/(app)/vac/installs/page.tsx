// Central vac installs. Foundation stub (owner: central-vac-installs).
import { requireUser } from "@/lib/session";
import { Empty } from "@/components/ui";
import { VacFrame, vacPageState } from "@/components/vac/vac-page";
import { listInstalls } from "@/lib/vac/installs";

export default async function Installs() {
  const user = await requireUser();
  const installs = await listInstalls(user.shopId);
  const s = await vacPageState(user, installs.length > 0);
  return (
    <VacFrame title="Central vac installs" tab="installs" what="Your installs" {...s}>
      <Empty>Coming in this update.</Empty>
    </VacFrame>
  );
}
