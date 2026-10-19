import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AuthError } from "next-auth";
import Link from "next/link";
import { signIn } from "@/auth";
import { rememberThisDevice } from "@/lib/known-device";
import { choiceCookieName, mintTicket } from "@/lib/sign-in-ticket";
import { appName } from "@/lib/shops";
import { foundrySignInMode } from "@/lib/foundry/mode";
import { linkFoundryAccount, type LinkRefusal } from "@/lib/foundry/signin";

// Linking a login to a Foundry Account (docs/plan.md FA-2). Only while FOUNDRY_SIGNIN is "on" or "only".

const WORDS: Record<LinkRefusal, string> = {
  old: "The old email and password don't match a login here.",
  several: "That email and password fit a login in more than one company. Sign in with your old login, then ask for the link from Settings (coming soon).",
  "foundry-wrong": "That Foundry Account email and password don't match.",
  "foundry-taken": "There is already a Foundry Account with that email. Untick “make me a Foundry Account” and use its password.",
  wait: "Too many tries. Wait a few minutes, then try again.",
  offline: "Can't reach the Foundry Account service just now. Check the internet and try again.",
  down: "The Foundry Account service had a problem. Try again in a minute.",
  "other-account": "This login is already linked to a different Foundry Account.",
  taken: "Another login in this company is already linked to that Foundry Account.",
  short: "A Foundry Account password needs at least 8 characters, and the email must be a real address.",
};

// Module level for the reason given in src/app/login/page.tsx above `back`.
function back(reason: LinkRefusal): never {
  redirect(`/login/link?error=${reason}`);
}

export default async function LinkPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (foundrySignInMode() === "off") notFound();
  const { error } = await searchParams;
  const shopApp = appName() === "StitchShop";
  const app = shopApp ? "StitchShop" : "StitchBench";

  async function link(formData: FormData) {
    "use server";
    if (foundrySignInMode() === "off") notFound();
    const r = await linkFoundryAccount(
      {
        email: formData.get("email"),
        password: formData.get("password"),
        foundryEmail: formData.get("foundryEmail"),
        foundryPassword: formData.get("foundryPassword"),
        create: formData.get("create") === "on",
      },
      await headers(),
    );
    if (!r.ok) back(r.reason);
    // Both proofs are in: sign this login in with a ticket that works once, as the sign-in page does.
    const ticket = mintTicket([r.login], null);
    try {
      if (!ticket) throw new AuthError("no ticket");
      await signIn("credentials", { ticket, userId: r.login.id, redirectTo: "/", redirect: false });
    } catch (e) {
      if (e instanceof AuthError) redirect("/login?linked=1");
      throw e;
    }
    await rememberThisDevice(r.login.id);
    (await cookies()).delete(choiceCookieName());
    redirect("/");
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form action={link} className="card card-pad w-full max-w-sm space-y-4">
        <div>
          <div className="text-2xl font-bold tracking-tight">Link your Foundry Account</div>
          <p className="muted text-sm">
            One login for all SiteSentrix software, and one balance of Foundry credits. Prove it is you twice: your old {app} login, then your Foundry Account.
          </p>
        </div>
        {error && (
          <p className="pill tone-bad whitespace-normal" role="alert">
            {WORDS[error as LinkRefusal] ?? "That didn't work. Check both and try again."}
          </p>
        )}
        <fieldset className="space-y-3">
          <legend className="label">Your old {app} login</legend>
          <div className="field">
            <label htmlFor="lo" className="label">
              Email
            </label>
            <input id="lo" name="email" type="email" autoComplete="username" required className="input" />
          </div>
          <div className="field">
            <label htmlFor="lp" className="label">
              Password
            </label>
            <input id="lp" name="password" type="password" autoComplete="current-password" required className="input" />
          </div>
        </fieldset>
        <fieldset className="space-y-3">
          <legend className="label">Your Foundry Account</legend>
          <div className="field">
            <label htmlFor="fe" className="label">
              Email
            </label>
            <input id="fe" name="foundryEmail" type="email" required className="input" />
          </div>
          <div className="field">
            <label htmlFor="fp" className="label">
              Password
            </label>
            <input id="fp" name="foundryPassword" type="password" autoComplete="off" required minLength={8} className="input" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="create" />
            <span>I don&apos;t have a Foundry Account yet: make me one</span>
          </label>
        </fieldset>
        <button className="btn btn-primary w-full">Link and sign in</button>
        <p className="muted text-center text-sm">
          <Link href="/login" className="link">
            Back to sign in
          </Link>
        </p>
      </form>
    </div>
  );
}
