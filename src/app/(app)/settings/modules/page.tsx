// Settings → Modules (Add-ons) was where a shop pasted its license keys until 1.8; the add-ons are free since and
// switched on in Settings → Features. Older links and emails still point here.
import { permanentRedirect } from "next/navigation";
import { SETTINGS_FEATURES_HREF } from "@/lib/module-info";

export default function ModulesPage() {
  permanentRedirect(SETTINGS_FEATURES_HREF);
}
