// Settings → Foundry Account (docs/plan.md FA-3): the desktop program's optional link. Only where the program has it switched on
// (FOUNDRY_LINK, src/lib/foundry/mode.ts). Owners and admins link; everyone else reads.
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { fmtDateTime } from "@/lib/format";
import { db } from "@/lib/db";
import { foundryLinkView } from "@/lib/foundry/link";
import { foundryLinkMode } from "@/lib/foundry/mode";
import { shopTimeZone } from "@/lib/shop-zone";
import { PageHeader, Section } from "@/components/ui";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { checkFoundryAccount, linkFoundryAccount, unlinkFoundryAccount } from "@/actions/foundry";

export default async function FoundryAccountPage() {
  if (foundryLinkMode() === "off") notFound();
  const user = await requireUser();
  const admin = user.role !== "TECH";
  const [v, shop, tz] = await Promise.all([foundryLinkView(user.shopId), db.shop.findUnique({ where: { id: user.shopId }, select: { name: true } }), shopTimeZone(user.shopId)]);
  if (!v) notFound();
  const required = v.mode === "required";

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Foundry Account" sub={`${shop?.name ?? "This company"}'s link to the one login for all SiteSentrix software.`} back={{ href: "/settings", label: "Settings" }} />

      <Section title="What linking does">
        <div className="space-y-2 text-sm">
          <p>
            This program works on its own, with or without a Foundry Account: tickets, the register, stock, printing and your manuals never need it, and keep working with
            no internet.
          </p>
          <p>
            {required ? (
              <>
                Linking is what opens the <strong>community hub</strong> (shared notes, manual links, the parts cross-reference, the marketplace and partner shops) and the{" "}
                <strong>Assistant</strong>. Without a link they stay off.
              </>
            ) : (
              <>Linking is what the community hub, partner shops and the Assistant will need. Nothing depends on it yet.</>
            )}{" "}
            You link once, with the internet on. After that the program doesn&apos;t need to be online to start or to work; the hub and the Assistant say so when the
            connection is down and come back when it is.
          </p>
        </div>
      </Section>

      {v.linked ? (
        <Section title="Linked">
          <div className="space-y-3 text-sm">
            <p>
              Account: <strong>{v.email}</strong>{" "}
              {v.state === "ok" ? <span className="pill tone-ready">linked</span> : <span className="pill tone-bad">sign in again</span>}
            </p>
            {v.state === "signed-out" && (
              <p className="pill tone-wait whitespace-normal" role="status">
                The Foundry Account service no longer accepts this sign-in (it may have ended, or the password changed). Unlink, then link again. Everything else keeps working.
              </p>
            )}
            <p className="muted">
              {v.creditsLeft !== null ? (
                <>
                  Foundry credits: <strong>{v.creditsLeft}</strong>
                  {v.checkedAt ? <> (as of {fmtDateTime(v.checkedAt, tz)})</> : null}
                  {v.reachable === false ? <>. Can&apos;t reach the service just now, so this is the last balance it gave.</> : null}
                </>
              ) : (
                <>The balance isn&apos;t known yet.</>
              )}
            </p>
            {v.reachable === false && v.creditsLeft === null && <p className="pill tone-wait whitespace-normal">Can&apos;t reach the Foundry Account service just now. Your link is kept.</p>}
            {admin ? (
              <div className="flex flex-wrap gap-2">
                <ActionButton action={checkFoundryAccount} className="btn btn-sm" success="Checked with the Foundry Account service">
                  Check now
                </ActionButton>
                <ActionButton action={unlinkFoundryAccount} className="btn btn-sm" success="Unlinked" confirm="Unlink the Foundry Account? The community hub and the Assistant stop until you link again.">
                  Unlink
                </ActionButton>
              </div>
            ) : (
              <p className="muted">Only the shop owner or an admin can change this.</p>
            )}
          </div>
        </Section>
      ) : (
        <Section title="Link a Foundry Account">
          {admin ? (
            <ActionForm action={linkFoundryAccount} success="Linked" className="space-y-3">
              <div className="field">
                <label htmlFor="fa-email" className="label">
                  Foundry Account email
                </label>
                <input id="fa-email" name="email" type="email" autoComplete="email" required className="input" />
              </div>
              <div className="field">
                <label htmlFor="fa-pass" className="label">
                  Foundry Account password
                </label>
                <input id="fa-pass" name="password" type="password" autoComplete="off" required className="input" />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="create" />
                <span>I don&apos;t have a Foundry Account yet: make me one</span>
              </label>
              <Submit className="btn btn-primary">Link</Submit>
              <p className="muted text-sm">The password goes to the Foundry Account service and is not kept here.</p>
            </ActionForm>
          ) : (
            <p className="text-sm muted">Only the shop owner or an admin can link a Foundry Account.</p>
          )}
        </Section>
      )}
    </div>
  );
}
