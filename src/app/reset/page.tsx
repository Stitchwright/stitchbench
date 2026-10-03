import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm, Submit } from "@/components/action-form";
import { finishPasswordReset, requestPasswordReset } from "@/actions/password-reset";
import { checkResetLink, resetByEmailProblem, SAME_ANSWER, TRAY_WORDS } from "@/lib/password-reset";
import { isDesktop } from "@/lib/modules";
import { appName } from "@/lib/shops";

// The link's token is in this page's address: no other site is told it (no Referer), and no search engine keeps the page.
export const metadata: Metadata = { referrer: "no-referrer", robots: { index: false, follow: false } };

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  const shopApp = appName() === "StitchShop";
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="card card-pad w-full max-w-sm space-y-4">
        <div>
          <div className="text-2xl font-bold tracking-tight">
            Stitch<span className="text-thread">{shopApp ? "Shop" : "Bench"}</span>
          </div>
          <p className="muted text-sm">{title}</p>
        </div>
        {children}
        <p className="muted text-center text-sm">
          <Link href="/login" className="link">
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

/**
 * /reset: "Forgot your password?" (an email with a link), and /reset?t=<token>: the page that link opens (and the
 * first-password link of a company started from StitchHub, and the administrator's reset link). Signed out by design
 * (src/auth.config.ts); not on the public links address (src/lib/links-host.ts). Hosted only.
 */
export default async function ResetPage({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const { t } = await searchParams;
  if (isDesktop()) {
    return (
      <Frame title="Forgot your password?">
        <p className="text-sm">{TRAY_WORDS}</p>
      </Frame>
    );
  }

  if (t) {
    const link = await checkResetLink(t);
    if (!link.ok) {
      return (
        <Frame title="Choose a new password">
          <p className="pill tone-bad whitespace-normal" role="alert">
            {link.reason}
          </p>
          <p className="text-sm">
            <Link href="/reset" className="link">
              Ask for a new link
            </Link>
          </p>
        </Frame>
      );
    }
    return (
      <Frame title={link.kind === "setup" ? "Choose your password" : "Choose a new password"}>
        <p className="text-sm">
          For <strong>{link.email}</strong>. {link.kind === "setup" ? "You sign in with it from now on." : "Every device signed in with the old password signs in again."}
        </p>
        <ActionForm action={finishPasswordReset} className="space-y-4">
          <input type="hidden" name="t" value={t} />
          <input type="text" name="username" autoComplete="username" value={link.email} readOnly hidden />
          <div className="field">
            <label htmlFor="password" className="label">
              New password (8 characters or more)
            </label>
            <input id="password" name="password" type="password" autoComplete="new-password" minLength={8} required className="input" />
          </div>
          <div className="field">
            <label htmlFor="again" className="label">
              The same password again
            </label>
            <input id="again" name="again" type="password" autoComplete="new-password" minLength={8} required className="input" />
          </div>
          <Submit className="btn btn-primary w-full">Save the password</Submit>
        </ActionForm>
      </Frame>
    );
  }

  const problem = resetByEmailProblem();
  return (
    <Frame title="Forgot your password?">
      {problem ? (
        <p className="text-sm" role="status">
          This {appName()} can&apos;t email a reset link yet. Ask its administrator: they can make you a link from the Companies page. Staff: your shop&apos;s owner or an admin can set a new password
          for you in Settings → People.
        </p>
      ) : (
        <>
          <p className="muted text-sm">Enter the email you sign in with. If it has a login here, we&apos;ll email a link to choose a new password; it works once, for an hour.</p>
          <ActionForm action={requestPasswordReset} success={SAME_ANSWER} className="space-y-4">
            <div className="field">
              <label htmlFor="email" className="label">
                Email
              </label>
              <input id="email" name="email" type="email" autoComplete="email" required className="input" />
            </div>
            <Submit className="btn btn-primary w-full">Send the link</Submit>
          </ActionForm>
        </>
      )}
    </Frame>
  );
}
