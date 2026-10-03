import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import Link from "next/link";
import { signIn } from "@/auth";
import { rememberThisDevice } from "@/lib/known-device";
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

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; ended?: string; reset?: string; callbackUrl?: string }> }) {
  const { error, ended, reset, callbackUrl } = await searchParams;
  const shopApp = appName() === "StitchShop";
  const next = landingPath(callbackUrl);

  async function login(formData: FormData) {
    "use server";
    const to = landingPath(formData.get("next"));
    try {
      await signIn("credentials", {
        email: formData.get("email"),
        password: formData.get("password"),
        redirectTo: to,
        redirect: false,
      });
    } catch (e) {
      // Back to the form with the same destination, so a second try still ends up on the page that was asked for.
      if (e instanceof AuthError) redirect(`/login?error=1${to === "/" ? "" : `&callbackUrl=${encodeURIComponent(to)}`}`);
      throw e;
    }
    // Signed in: this browser is known for that login from now on, so a flood of wrong passwords sent at the account
    // from elsewhere can't queue it out (src/lib/known-device.ts).
    await rememberThisDevice(formData.get("email"));
    redirect(to);
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
