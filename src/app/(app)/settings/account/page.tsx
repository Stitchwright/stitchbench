// Settings → Account (hub-accounts-billing-design.md 2.2 and 3.5): the company's StitchHub account (started from here
// with the owner's email, or an existing one connected with a link code), the standing the hub last gave, the terms
// links and the reset opt-in. The program is free (free-software-design.md): only on the owner's hosted service, where
// hosting is billed (HOSTING_BILLING=on), does this page show the hosting's standing. Owners only; everyone else reads.
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { accountView, linkCodeShown, NAG_AFTER_DAYS } from "@/lib/hub-account";
import { isDraftTerms } from "@/lib/terms-version";
import { NO_END } from "@/lib/license";
import { endedDay, fmtYmd, programName, SETTINGS_FEATURES_HREF, type ModuleState } from "@/lib/module-info";
import { hostingBilling } from "@/lib/modules";
import { PageHeader, Section } from "@/components/ui";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { CopyButton } from "@/components/copy-button";
import { makeHubLinkCode, refreshHubStanding, setHubResetOptIn, startHubAccount } from "@/actions/account";

/** The hub's standing word in plain words. */
const STANDING: Record<string, string> = {
  free: "Free",
  trial: "Free trial",
  active: "Paid",
  past_due: "Payment overdue",
  waived: "Free while partnered",
  comped: "Free, with the hub admin's compliments",
  lapsed: "Lapsed",
};

/** The hosting's standing, from the program's own key (the owner's hosted service only). */
function HostingLine({ s, program }: { s: ModuleState; program: string }) {
  const until = s.lastDay && s.lastDay < NO_END ? fmtYmd(s.lastDay) : null;
  switch (s.status) {
    case "on":
      return <span className="pill tone-ready">{until ? `Hosting paid through ${until}` : "Hosting paid"}</span>;
    case "renew":
      return <span className="pill tone-wait">Hosting paid through {until ?? "-"}: the next payment is due</span>;
    case "grace":
      return (
        <span className="pill tone-bad">
          Hosting ended {until ?? "-"}; keeps working until {s.graceLastDay ? fmtYmd(s.graceLastDay) : "-"}
        </span>
      );
    case "lapsed":
      return <span className="pill tone-bad">Read-only since {endedDay(s)}</span>;
    default:
      return <span className="pill tone-neutral">{program} works here: nothing is due yet</span>;
  }
}

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ code?: string; until?: string }> }) {
  const user = await requireUser();
  const [v, sp] = await Promise.all([accountView(user), searchParams]);
  const program = programName();
  const tz = v.shop.timeZone;
  const { shop } = v;
  // A link code just made (door 2), while it is still good.
  const shown = linkCodeShown(sp.code, sp.until);
  const code = shown?.code ?? null;
  const until = shown?.until ?? null;
  const waiting = !!shop.hubAccountEmail && !shop.hubAccountVerified;
  const standingWord = shop.hubStanding ? (STANDING[shop.hubStanding] ?? shop.hubStanding) : null;
  const nag = v.neverConnected && v.ageDays >= NAG_AFTER_DAYS;
  const hosting = hostingBilling();

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Account" sub={`${shop.name}'s StitchHub account: who the shop is on the community hub, the terms, and password help.`} back={{ href: "/settings", label: "Settings" }} />

      <Section title={`${program} for this company`}>
        <div className="space-y-2 text-sm">
          {hosting ? (
            <div className="flex flex-wrap items-center gap-2">
              <HostingLine s={v.base} program={program} />
            </div>
          ) : (
            <p data-testid="free-line">
              {program} is free: every feature, for every shop, with nothing to pay and no key to enter. Switch on the extras your shop uses in{" "}
              <Link href={SETTINGS_FEATURES_HREF} className="link">
                Settings → Features
              </Link>
              .
            </p>
          )}
          {hosting && v.base.status === "lapsed" && (
            <p>
              Everything stays here to look at, print and export; open work can be finished and payments taken. New tickets, sales and edits wait until the hosting is paid on your StitchHub
              account below. Or take the company to the free Windows program:{" "}
              <Link href="/settings#move" className="link">
                Settings → Company
              </Link>
              .
            </p>
          )}
          {standingWord && (
            <p>
              StitchHub says: <strong>{standingWord}</strong>
              {shop.hubStandingUntil && shop.hubStandingUntil < NO_END && <> through {fmtYmd(shop.hubStandingUntil)}</>}. {shop.hubStandingNote}
              {shop.hubStandingAt && <span className="muted"> (checked {fmtDateTime(shop.hubStandingAt, tz)})</span>}
            </p>
          )}
          {v.connected && !standingWord && <p className="muted">The hub hasn&apos;t said anything about this company yet. It does at the next sync, or press Check again.</p>}
          {!v.connected && <p className="muted">This program isn&apos;t connected to StitchHub. It works as it is, with every feature; a StitchHub account is free, and connects the shop to the community.</p>}
          {nag && (
            <p className="pill tone-wait inline-block whitespace-normal">
              {program} has run here for {v.ageDays} days without a StitchHub account. Nothing stops, but please create one below (it&apos;s free) so StitchBench knows about this shop and can help
              when you ask.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="label">Company ID</span>
            <span className="mono" data-testid="company-id">
              {shop.id}
            </span>
            <CopyButton text={shop.id} />
          </div>
          {v.connected && v.mayManage && (
            <ActionButton action={refreshHubStanding} className="btn btn-sm" success="Checked with StitchHub">
              Check again
            </ActionButton>
          )}
        </div>
      </Section>

      <Section title="StitchHub account">
        {shop.hubAccountEmail ? (
          <div className="space-y-3 text-sm">
            <p>
              Account: <strong>{shop.hubAccountEmail}</strong>{" "}
              {shop.hubAccountVerified ? <span className="pill tone-ready">verified</span> : <span className="pill tone-wait">waiting for the email</span>}
            </p>
            {waiting && (
              <>
                <p className="muted">
                  Open the email from {v.hubName ?? "StitchHub"} and set a password; the link works once, for 24 hours. Nothing arrived? Check the spam folder, then send it again.
                </p>
                {v.mayManage && (
                  <ActionForm action={startHubAccount} success="Email sent again" className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="email" value={shop.hubAccountEmail} />
                    <input type="hidden" name="terms" value="on" />
                    <Submit className="btn btn-sm">Send it again</Submit>
                  </ActionForm>
                )}
              </>
            )}
            <p>
              Manage the account (other shops, the password, and the Assistant or hosting if you have them) on{" "}
              <a href={`${v.hubUrl}/account`} target="_blank" rel="noreferrer" className="link">
                {v.hubUrl.replace(/^https?:\/\//, "")}/account
              </a>
              .
            </p>
            <p data-testid="terms-accepted">
              {shop.termsVersion ? <>Terms accepted: version {shop.termsVersion}</> : <>No terms version recorded here yet (StitchHub keeps the record)</>} (
              <a href={`${v.hubUrl}/terms`} target="_blank" rel="noreferrer" className="link">
                terms
              </a>
              ,{" "}
              <a href={`${v.hubUrl}/privacy`} target="_blank" rel="noreferrer" className="link">
                privacy policy
              </a>
              ).
            </p>
            {v.terms.behind && (
              <p className="pill tone-wait inline-block whitespace-normal">
                StitchHub has updated its terms to version {v.terms.current}. Read them and accept them on{" "}
                <a href={`${v.hubUrl}/account`} target="_blank" rel="noreferrer" className="underline">
                  your account page
                </a>
                .
              </p>
            )}
          </div>
        ) : !v.mayManage ? (
          <p className="muted text-sm">This company has no StitchHub account yet. The shop owner creates it here.</p>
        ) : (
          <div className="space-y-5 text-sm">
            <ActionForm action={startHubAccount} success="Account started: check your email" className="space-y-3">
              <h3 className="font-semibold">Create your StitchHub account</h3>
              <p className="muted">
                One account, with your email and a password, owns this shop on StitchHub. It&apos;s free. It is also where you can add the Assistant, or have SiteSentrix host the shop for
                you.{" "}
                {!v.connected && `Creating it also connects this program to ${v.hubUrl.replace(/^https?:\/\//, "")} (no invite needed).`}
              </p>
              <div className="field max-w-sm">
                <label htmlFor="acct-email" className="label">
                  Your email
                </label>
                <input id="acct-email" name="email" type="email" className="input" defaultValue={v.ownerEmail} required autoComplete="email" />
              </div>
              <label className="flex items-start gap-2">
                <input type="checkbox" name="terms" className="check mt-0.5" required />
                <input type="hidden" name="termsVersion" value={v.terms.current} />
                <span>
                  I accept the{" "}
                  <a href={`${v.hubUrl}/terms`} target="_blank" rel="noreferrer" className="link">
                    terms
                  </a>{" "}
                  and the{" "}
                  <a href={`${v.hubUrl}/privacy`} target="_blank" rel="noreferrer" className="link">
                    privacy policy
                  </a>{" "}
                  <span className="muted">
                    (version {v.terms.current}
                    {isDraftTerms(v.terms.current) && ", a draft, not yet in force"})
                  </span>
                </span>
              </label>
              <Submit>Create account</Submit>
            </ActionForm>

            <div className="space-y-2 border-t border-line pt-4">
              <h3 className="font-semibold">I already have an account</h3>
              {code ? (
                <div className="space-y-2">
                  <p>
                    Sign in on{" "}
                    <a href={`${v.hubUrl}/account`} target="_blank" rel="noreferrer" className="link">
                      {v.hubUrl.replace(/^https?:\/\//, "")}/account
                    </a>{" "}
                    and type this code under <strong>Connect a shop</strong>. It works once, until {fmtDateTime(until!, tz, { hour: "numeric", minute: "2-digit" })}.
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="mono text-2xl tracking-widest" data-testid="link-code">
                      {code}
                    </span>
                    <CopyButton text={code} />
                  </div>
                  <p className="muted">The page learns about the connection at the next sync, or when you press Check again.</p>
                </div>
              ) : (
                <>
                  <p className="muted">Connect this shop to the account you have: the program shows a code, and you type it in on the hub.</p>
                  <ActionButton action={makeHubLinkCode} className="btn btn-sm" success="Code made">
                    Show a link code
                  </ActionButton>
                </>
              )}
            </div>
          </div>
        )}
      </Section>

      {v.desktop && (
        <Section title="Password reset from StitchHub">
          <div className="space-y-2 text-sm">
            <p className="muted">
              Off by default. When on, the owner can ask for a new password for this program from their StitchHub account; the new password is shown only in this program&apos;s own window on the shop
              PC, never emailed. (The tray menu&apos;s &quot;Reset a password&quot; always works on the PC itself.)
            </p>
            <p>
              <span className={`pill ${shop.hubResetOptIn ? "tone-ready" : "tone-neutral"}`}>{shop.hubResetOptIn ? "Allowed" : "Not allowed"}</span>{" "}
              {v.mayManage && (
                <ActionButton
                  action={setHubResetOptIn.bind(null, !shop.hubResetOptIn)}
                  className="btn btn-sm"
                  success={shop.hubResetOptIn ? "Reset from StitchHub switched off" : "Reset from StitchHub allowed"}
                >
                  {shop.hubResetOptIn ? "Don't allow" : "Allow a reset from my StitchHub account"}
                </ActionButton>
              )}
            </p>
          </div>
        </Section>
      )}

      <p className="muted text-sm">
        Connected to the hub since {v.connected ? "yes" : "no"}
        {v.scope === "pending" && " (waiting for the account's email to be opened)"}
        {v.scope === "partner" && " (for partner shops only)"}. Company made {fmtDate(shop.createdAt, tz)}.{" "}
        <Link href="/settings#hub" className="link">
          StitchHub settings
        </Link>
      </p>
    </div>
  );
}
