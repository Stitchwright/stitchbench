"use server";
// The Help button (help-feedback-design.md section 1) and the browser's error alerts (section 2). Both work while the
// program is read-only: a lapsed shop needs help most.
import { safe, UserError } from "@/lib/action";
import { db } from "@/lib/db";
import { requireUser, sessionUser } from "@/lib/session";
import { validEmail } from "@/lib/phone";
import { addHelpItem, helpContext, HELP_PICTURE_MAX, recordError } from "@/lib/help";

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v : "";
};

/** "Something's wrong", "Report a bug", "I have an idea" or "Rate the program", from the Help panel. */
export const sendHelp = safe.whileLapsed("sendHelp")(async function sendHelp(fd: FormData) {
  const user = await requireUser();
  const kind = str(fd, "kind");
  if (kind !== "help" && kind !== "bug" && kind !== "idea" && kind !== "rating") throw new UserError("Please pick one of the choices.");
  const typed = str(fd, "replyTo").trim();
  const replyTo = typed ? validEmail(typed) : null;
  if (typed && !replyTo) throw new UserError("That email address doesn't look right. Fix it, or leave the box empty.");
  let picture: Uint8Array | null = null;
  const file = fd.get("picture");
  if ((kind === "help" || kind === "bug") && file instanceof Blob && file.size > 0 && file.size <= HELP_PICTURE_MAX) picture = new Uint8Array(await file.arrayBuffer());
  const shop = await db.shop.findUnique({ where: { id: user.shopId }, select: { name: true } });
  await addHelpItem(
    user.shopId,
    { kind, text: str(fd, "text") || null, steps: str(fd, "steps") || null, stars: Number(str(fd, "stars")) || null, quoteOk: str(fd, "quoteOk") === "on" || str(fd, "quoteOk") === "true", replyTo, picture },
    helpContext({ path: str(fd, "path"), role: user.role, userAgent: str(fd, "userAgent"), screen: str(fd, "screen"), shopName: shop?.name ?? null }),
  );
});

export type BrowserError = { message?: string; stack?: string; digest?: string; path?: string; userAgent?: string; screen?: string; source?: string };

/** An error a page showed or the browser caught (at most 5 a page load, the page's own limit). Nobody signed in: dropped. */
export const reportBrowserError = safe.whileLapsed("reportBrowserError")(async function reportBrowserError(e: BrowserError) {
  const user = await sessionUser();
  if (!user || !e || typeof e !== "object") return;
  await recordError(
    user.shopId,
    { message: e.message, stack: e.stack, digest: e.digest, action: e.source === "page" ? "page" : "browser" },
    helpContext({ path: e.path, role: user.role, userAgent: e.userAgent, screen: e.screen }),
  );
});

/**
 * Test only (HELP_TEST_ERRORS=1, tests/help.spec.ts through /api/help/test-error): an action that fails the way a fault
 * in the program does, with a phone and a card number in its message that the alert must not carry. Elsewhere: refused.
 */
export const helpTestError = safe(async function helpTestError(tag: string) {
  if (process.env.HELP_TEST_ERRORS !== "1") throw new UserError("Not available.");
  const t = /^[A-Za-z0-9]{1,20}$/.test(String(tag)) ? tag : "x";
  throw new Error(`Help test error ${t}: call 555-123-4567 about card 4111 1111 1111 1111`);
});
