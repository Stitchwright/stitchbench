"use server";

// Settings → Foundry Account (the desktop program's optional link, docs/plan.md FA-3). Bodies: src/lib/foundry/link.ts.
// Owners and admins; the lib refuses anyone else. These work while the program is read-only (safe.whileLapsed): the link is
// not a paid feature and is the way to the community hub.
import { revalidatePath } from "next/cache";
import { safe, UserError } from "@/lib/action";
import { foundryLinkMode } from "@/lib/foundry/mode";
import { linkFoundry, unlinkFoundry, verifyLink } from "@/lib/foundry/link";
import { requireAdmin } from "@/lib/session";

function refresh() {
  revalidatePath("/", "layout");
}

function needSwitch() {
  if (foundryLinkMode() === "off") throw new UserError("The Foundry Account link isn't switched on in this program.");
}

export const linkFoundryAccount = safe.whileLapsed("linkFoundryAccount")(async function linkFoundryAccount(fd: FormData) {
  needSwitch();
  const user = await requireAdmin();
  await linkFoundry(user, { email: fd.get("email"), password: fd.get("password"), create: fd.get("create") === "on" });
  refresh();
});

export const unlinkFoundryAccount = safe.whileLapsed("unlinkFoundryAccount")(async function unlinkFoundryAccount() {
  needSwitch();
  await unlinkFoundry(await requireAdmin());
  refresh();
});

export const checkFoundryAccount = safe.whileLapsed("checkFoundryAccount")(async function checkFoundryAccount() {
  needSwitch();
  const user = await requireAdmin();
  const c = await verifyLink(user.shopId, { timeoutMs: 8000 });
  if (c.state === "unreachable") throw new UserError("Can't reach the Foundry Account service just now. Your link is kept; try again when the internet is back.");
  refresh();
});
