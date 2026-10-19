import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { foundrySignInMode } from "@/lib/foundry/mode";
import { sendFoundryReset } from "@/lib/foundry/signin";

// A forgotten Foundry Account password: the account service emails the link (docs/cloud.md), so nothing is kept here.
const WORDS = {
  sent: "If there's a Foundry Account with that email, a link to set a new password is on its way. It works for an hour.",
  offline: "Can't reach the Foundry Account service just now. Check the internet and try again.",
  down: "Sending the email isn't set up on the Foundry Account service yet. Try again later.",
  wait: "A few emails went to that address lately. Wait 15 minutes and try again.",
} as const;

export default async function ForgotPage({ searchParams }: { searchParams: Promise<{ said?: string }> }) {
  if (foundrySignInMode() === "off") notFound();
  const { said } = await searchParams;

  async function ask(formData: FormData) {
    "use server";
    if (foundrySignInMode() === "off") notFound();
    const r = await sendFoundryReset(formData.get("email"));
    redirect(`/login/forgot?said=${r}`);
  }

  const message = said && said in WORDS ? WORDS[said as keyof typeof WORDS] : null;
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form action={ask} className="card card-pad w-full max-w-sm space-y-4">
        <div>
          <div className="text-2xl font-bold tracking-tight">Forgot your password?</div>
          <p className="muted text-sm">Type your Foundry Account email and we&apos;ll ask the account service to email you a link.</p>
        </div>
        {message && (
          <p className={`pill whitespace-normal ${said === "sent" ? "tone-ready" : "tone-wait"}`} role="status">
            {message}
          </p>
        )}
        <div className="field">
          <label htmlFor="em" className="label">
            Email
          </label>
          <input id="em" name="email" type="email" autoComplete="email" required className="input" />
        </div>
        <button className="btn btn-primary w-full">Email me a link</button>
        <p className="muted text-center text-sm">
          <Link href="/login" className="link">
            Back to sign in
          </Link>
        </p>
      </form>
    </div>
  );
}
