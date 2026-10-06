import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import Link from "next/link";
import { signIn } from "@/auth";
import { db } from "@/lib/db";
import { rememberThisDevice } from "@/lib/known-device";
import { signInStep } from "@/lib/sign-in";
import { choiceCookieName, mintTicket, newNonce, readTicket, TICKET_MINUTES } from "@/lib/sign-in-ticket";
import { appName } from "@/lib/shops";
import { isDesktop } from "@/lib/modules";
import { HubResetPrompt } from "@/components/hub-reset-prompt";
import { HubLegalLinks } from "@/components/hub-legal-links";

/**
 * Where to go after signing in: the page the person was sent from (the proxy adds ?callbackUrl=<that page's address>), as
 * a path on this site only. Anything else, like //other.site or a path with a backslash, means the dashboard.
 */
function landingPath(value: unknown) {
  if (typeof value !== "string" || !value) return "/";
  let path: string;
  try {
    const u = new URL(value, "http://this.site"); // a full address or a path: only its path and query are kept
    path = u.pathname + u.search;
  } catch {
    return "/";
  }
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || /^\/(login|signup|reset|api)(\/|\?|$)/.test(path)) return "/";
  return path;
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; ended?: string; reset?: string; callbackUrl?: string; choose?: string }> }) {
  const { error, ended, reset, callbackUrl, choose } = await searchParams;
  const shopApp = appName() === "StitchShop";
  const next = landingPath(callbackUrl);

  const back = (to: string, extra = "error=1") => redirect(`/login?${extra}${to === "/" ? "" : `&callbackUrl=${encodeURIComponent(to)}`}`);

  /** Signs in with a ticket (src/lib/sign-in-ticket.ts) for one login; this browser is known for that login from then on. */
  async function enter(ticket: string | null, userId: string, to: string) {
    try {
      if (!ticket) throw new AuthError("no ticket");
      await signIn("credentials", { ticket, userId, redirectTo: to, redirect: false });
    } catch (e) {
      // Back to the form with the same destination, so a second try still ends up on the page that was asked for.
      if (e instanceof AuthError) back(to);
      throw e;
    }
    // Signed in: this browser is known for that login from now on, so a flood of wrong passwords sent at the account
    // from elsewhere can't queue it out (src/lib/known-device.ts).
    await rememberThisDevice(userId);
    (await cookies()).delete(choiceCookieName());
    redirect(to);
  }

  async function login(formData: FormData) {
    "use server";
    const to = landingPath(formData.get("next"));
    // The password is checked once, with its limits. One login fits: signed in. Several (the same email in more than one
    // company): the "Choose a company" step, carried by a signed ticket so the password is not sent again.
    const found = await signInStep({ email: formData.get("email"), password: formData.get("password") }, await headers());
    if (!found) back(to);
    const logins = found!.map((u) => ({ id: u.id, sv: u.sv }));
    if (logins.length === 1) return enter(mintTicket(logins, null), logins[0].id, to);
    const nonce = newNonce();
    const ticket = mintTicket(logins, nonce);
    if (!ticket) back(to);
    const proto = (await headers()).get("x-forwarded-proto")?.split(",")[0]?.trim();
    (await cookies()).set(choiceCookieName(), nonce, { httpOnly: true, sameSite: "lax", path: "/", secure: proto === "https", maxAge: TICKET_MINUTES * 60 });
    back(to, `choose=${encodeURIComponent(ticket!)}`);
  }

  async function chooseCompany(formData: FormData) {
    "use server";
    const to = landingPath(formData.get("next"));
    await enter(String(formData.get("ticket") ?? ""), String(formData.get("userId") ?? ""), to);
  }

  // The company names are shown only for a ticket a right password earned, made for this browser and still fresh.
  const nonce = choose ? ((await cookies()).get(choiceCookieName())?.value ?? null) : null;
  const ticket = choose ? readTicket(choose, nonce) : null;
  const choices = ticket
    ? (await db.user.findMany({ where: { id: { in: ticket.l.map((e) => e[0]) }, active: true }, select: { id: true, shop: { select: { name: true } } } }))
        .map((u) => ({ id: u.id, company: u.shop.name }))
        .sort((a, b) => a.company.localeCompare(b.company))
    : [];
  if (choose && choices.length) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <form action={chooseCompany} className="card card-pad w-full max-w-sm space-y-4">
          <input type="hidden" name="next" value={next} />
          <input type="hidden" name="ticket" value={choose} />
          <div>
            <div className="text-2xl font-bold tracking-tight">Choose a company</div>
            <p className="muted text-sm">This email and password have a login in more than one company. Which one do you want now?</p>
          </div>
          <div className="space-y-2">
            {choices.map((c) => (
              <button key={c.id} name="userId" value={c.id} className="btn btn-primary w-full">
                {c.company}
              </button>
            ))}
          </div>
          <p className="muted text-center text-sm">
            <Link href="/login" className="link">
              Start over
            </Link>
          </p>
        </form>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form action={login} className="card card-pad w-full max-w-sm space-y-4">
        <input type="hidden" name="next" value={next} />
        <div>
          <div className="text-2xl font-bold tracking-tight">
            Stitch<span className="text-thread">{shopApp ? "Shop" : "Bench"}</span>
          </div>
          <p className="muted text-sm">{shopApp ? "Sign in to your shop." : "Sign in to your repair bench."}</p>
        </div>
        {choose && !choices.length && !error && (
          <p className="pill tone-wait whitespace-normal" role="status">
            That step timed out or can&apos;t be used. Sign in again.
          </p>
        )}
        {error && (
          <p className="pill tone-bad" role="alert">
            Email or password is wrong. After several wrong tries, signing in to that account slows down for 15 minutes.
          </p>
        )}
        {ended && !error && !reset && (
          <p className="pill tone-wait" role="status">
            Please sign in again: your password or your access changed.
          </p>
        )}
        {reset && !error && (
          <p className="pill tone-ready whitespace-normal" role="status">
            Your password is set. Sign in with it.
          </p>
        )}
        <div className="field">
          <label htmlFor="email" className="label">
            Email
          </label>
          <input id="email" name="email" type="email" autoComplete="email" required className="input" />
        </div>
        <div className="field">
          <label htmlFor="password" className="label">
            Password
          </label>
          <input id="password" name="password" type="password" autoComplete="current-password" required className="input" />
        </div>
        <button className="btn btn-primary w-full">Sign in</button>
        {/* A link by email on the hosted service (src/app/reset); the Windows program resets from its tray icon. */}
        {!isDesktop() && (
          <p className="text-center text-sm">
            <Link href="/reset" className="link">
              Forgot your password?
            </Link>
          </p>
        )}
        {/* The Windows program's first-run sign-up (SETUP_TOKEN) is only for its own window, which opens it directly. */}
        {process.env.ALLOW_SIGNUP === "true" && !process.env.SETUP_TOKEN && (
          <p className="muted text-center text-sm">
            New shop?{" "}
            <Link href="/signup" className="link">
              Create an account
            </Link>
          </p>
        )}
        {/* StitchHub's Terms of Service and Privacy Policy, when this install is on a hub. */}
        <HubLegalLinks />
      </form>
      {/* The Windows program's own window only: a reset the owner asked for on their StitchHub account. */}
      <HubResetPrompt pull />
    </div>
  );
}
