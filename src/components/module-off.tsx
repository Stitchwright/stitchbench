// The notice a scheduling or messaging page shows when its module is off or has ended (design 6.1).
import type { ModuleKey } from "@/lib/module-gate";
import { ModuleNoticeFor } from "@/components/module-notice";

export function ModuleOff({ shopId, module, what, admin }: { shopId: string; module: ModuleKey; what?: string; admin?: boolean }) {
  return <ModuleNoticeFor shopId={shopId} module={module} what={what} admin={admin} />;
}
