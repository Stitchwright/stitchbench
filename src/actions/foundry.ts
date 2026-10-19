"use server";

// Settings → Foundry Account (the desktop program's optional link, docs/plan.md FA-3). Bodies: src/lib/foundry/link.ts.
// Owners and admins; the lib refuses anyone else. These work while the program is read-only (safe.whileLapsed): the link is
// not a paid feature and is the way to the community hub.
import { revalidatePath } from "next/cache";
import { safe, UserError } from "@/lib/action";
import { foundryLinkMode } from "@/lib/foundry/mode";
import { linkFoundry, unlinkFoundry, verifyLink } from "@/lib/foundry/link";
import { foundrySignInMode } from "@/lib/foundry/switches";
import { linkFoundryAccount as linkLogin, type LinkRefusal } from "@/lib/foundry/signin";
import { requireAdmin, requireUser } from "@/lib/session";
import { db } from "@/lib/db";

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

/** What a refused link says, in the words of the link page (src/app/login/link/page.tsx), for the ones that can happen from Settings. */
const WHY: Partial<Record<LinkRefusal, string>> = {
  "foundry-wrong": "That Foundry Account email and password don't match.",
  "foundry-taken": "There is already a Foundry Account with that email. Untick “make me one” and use its password.",
  wait: "Too many tries. Wait a few minutes, then try again.",
  offline: "Can't reach the Foundry Account service just now. Check the internet and try again.",
  down: "The Foundry Account service had a problem. Try again in a minute.",
  "other-account": "This login is already linked to a different Foundry Account. Ask the owner or an admin for a sign-in link to change it.",
  taken: "Another login in this company is already linked to that Foundry Account.",
  short: "A Foundry Account password needs at least 8 characters, and the email must be a real address.",
};

/**
 * Settings → Foundry Account (hosted, FOUNDRY_SIGNIN on or only): the signed-in person links their own login to a Foundry Account.
 * Their session is the proof, so it works for a login that shares an email and password with logins in other companies, one
 * company at a time (the link page can't tell those apart). Docs/plan.md FA-2 follow-up.
 */
export const linkMyLogin = safe.whileLapsed("linkMyLogin")(async function linkMyLogin(fd: FormData) {
  if (foundrySignInMode() === "off") throw new UserError("Signing in with a Foundry Account isn't switched on here.");
  const user = await requireUser();
  const row = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { sessionVersion: true } });
  const r = await linkLogin(
    { signedIn: { id: user.id, sv: row.sessionVersion }, foundryEmail: fd.get("email"), foundryPassword: fd.get("password"), create: fd.get("create") === "on" },
    undefined,
  );
  if (!r.ok) throw new UserError(WHY[r.reason] ?? "That didn't work. Check both and try again.");
  refresh();
});
