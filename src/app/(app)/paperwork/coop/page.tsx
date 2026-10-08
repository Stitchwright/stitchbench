// Paperwork → Co-op and rebates (shop-features-round-2-design.md 9.2): money makers pay back for ads and rebate programs.
// What each maker owes, the claims (deadlines first while not sent), and "Add a claim" for an owner or admin.
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { money } from "@/lib/format";
import { COOP_KIND_LABEL, COOP_LABEL, COOP_TONE, coopList, coopTotals, dayWords } from "@/lib/coop-claims";
import { startCoop } from "@/actions/coop-claims";
import { ActionForm, Submit } from "@/components/action-form";
import { Empty, Section } from "@/components/ui";
import { PaperFrame } from "@/components/paperwork/frame";
import { CoopFields } from "@/components/paperwork/coop-fields";

export default async function CoopPage() {
  const user = await requireUser();
  const admin = user.role !== "TECH";
  const [claims, totals] = await Promise.all([coopList(user.shopId), coopTotals(user.shopId)]);
  const open = claims.filter((c) => c.status === "OPEN").sort((a, b) => (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999"));
  const rest = claims.filter((c) => c.status !== "OPEN");
  const row = (c: (typeof claims)[number]) => (
    <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
      <span className="text-base">
        <Link href={`/paperwork/coop/${c.id}`} className="link">
          #{c.number} {c.maker}: {c.program ?? COOP_KIND_LABEL[c.kind]}
        </Link>
        {c.status === "OPEN" && c.deadline && <span className="muted text-sm"> · send by {dayWords(c.deadline)}</span>}
      </span>
      <span className="flex flex-wrap items-center gap-2 text-base">
        <span className="num">{money(c.claimCents)}</span>
        <span className={`pill ${COOP_TONE[c.status] ?? ""}`}>{COOP_LABEL[c.status] ?? c.status}</span>
      </span>
    </li>
  );
  return (
    <PaperFrame title="Co-op and rebates" tab="coop" admin={admin} sub="Makers pay back part of your ads and pay rebates on machines sold. Keep the proof here and send each claim before its deadline.">
      {totals.some((t) => t.waitingCents > 0) && (
        <Section title="Owed to you">
          <ul className="divide-y divide-line">
            {totals
              .filter((t) => t.waitingCents > 0)
              .map((t) => (
                <li key={t.maker} className="flex justify-between py-2 text-base">
                  <span>{t.maker}</span>
                  <span className="num font-semibold">{money(t.waitingCents)}</span>
                </li>
              ))}
          </ul>
        </Section>
      )}
      <Section title={`Not sent yet (${open.length})`}>{open.length ? <ul className="divide-y divide-line">{open.map(row)}</ul> : <Empty>Nothing waiting to be sent. When you run an ad a maker helps pay for, add it below with a photo of the ad.</Empty>}</Section>
      {admin && (
        <Section title="Add a claim">
          <ActionForm action={startCoop} className="grid gap-3 sm:grid-cols-2">
            <CoopFields p="new-" d={{ maker: "", kind: "COOP", program: "", adWhere: "", placedOn: "", spent: "", claim: "", deadline: "", note: "" }} />
            <div className="sm:col-span-2">
              <Submit>Add the claim</Submit>
            </div>
          </ActionForm>
        </Section>
      )}
      {rest.length > 0 && (
        <Section title="Sent and settled">
          <ul className="divide-y divide-line">{rest.map(row)}</ul>
        </Section>
      )}
    </PaperFrame>
  );
}
