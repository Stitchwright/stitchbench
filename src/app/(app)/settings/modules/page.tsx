import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDateTime } from "@/lib/format";
import { todayIn } from "@/lib/time-zone";
import { getModules } from "@/lib/modules";
import { shopKinds } from "@/lib/equipment/shop";
import { fmtYmd, MODULE_SALES, MODULE_SALES_NOTE, MODULES, PAID_MODULE_IDS, planLabel, salesMailto, SETTINGS_ACCOUNT_HREF, type KeyView, type ModuleState } from "@/lib/module-info";
import { PageHeader, Section } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { CopyButton } from "@/components/copy-button";
import { activateLicense } from "@/actions/licenses";

/** "2027-09-30" -> "Sep 30" (the year is left off where the sentence already says it is soon). */
function shortDay(ymd: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
}

/** Whole days from today (in the shop's zone) to a day. */
function daysUntil(ymd: string, timeZone: string) {
  return Math.round((Date.parse(`${ymd}T00:00:00Z`) - Date.parse(`${todayIn(timeZone)}T00:00:00Z`)) / 86_400_000);
}

function StatusPill({ s, timeZone }: { s: ModuleState; timeZone: string }) {
  switch (s.status) {
    case "on":
      return <span className="pill tone-ready">On until {s.lastDay ? fmtYmd(s.lastDay) : "-"}</span>;
    case "renew": {
      const days = s.lastDay ? daysUntil(s.lastDay, timeZone) : null;
      return (
        <span className="pill tone-wait">
          Ends {s.lastDay ? shortDay(s.lastDay) : "-"}
          {days != null && ` (${days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`})`}
        </span>
      );
    }
    case "grace":
      return (
        <span className="pill tone-bad">
          Ended {s.lastDay ? shortDay(s.lastDay) : "-"}, working until {s.graceLastDay ? shortDay(s.graceLastDay) : "-"}
        </span>
      );
    case "lapsed":
      return <span className="pill tone-neutral">{s.switchedOff ? "Switched off" : "Ended"} {s.lastDay ? fmtYmd(s.lastDay) : "-"}</span>;
    default:
      return <span className="pill tone-neutral">{s.startsOn ? `Starts ${shortDay(s.startsOn)}` : "Not on"}</span>;
  }
}

/** What the renew pill means for this plan (section 5.4). */
function RenewLine({ s }: { s: ModuleState }) {
  if (s.status !== "renew" || !s.lastDay) return null;
  const day = shortDay(s.lastDay);
  switch (s.plan) {
    case "m":
      return <div className="muted mt-1 text-xs">Your next key comes by email after your monthly payment. Nothing to do until it arrives.</div>;
    case "a":
      return <div className="muted mt-1 text-xs">Turned on by StitchBench until {day}.</div>;
    case "t":
      return <div className="muted mt-1 text-xs">Your trial ends {day}.</div>;
    default:
      return null;
  }
}

function KeyStatePill({ k }: { k: KeyView }) {
  switch (k.state) {
    case "current":
      return <span className="pill tone-ready">Current</span>;
    case "future":
      return <span className="pill tone-wait">Starts {k.from ? fmtYmd(k.from) : "later"}</span>;
    case "ended":
      return <span className="pill tone-neutral">Ended</span>;
    case "other-company":
      return <span className="pill tone-bad">For another company</span>;
    default:
      return <span className="pill tone-bad">Not valid: {k.reason ?? "it doesn't verify"}</span>;
  }
}

function Check({ done, href, children }: { done: boolean; href: string; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span aria-hidden className={done ? undefined : "muted"} style={done ? { color: "var(--ok)" } : undefined}>
        {done ? "✓" : "○"}
      </span>
      {done ? (
        <span>{children}</span>
      ) : (
        <Link href={href} className="link">
          {children}
        </Link>
      )}
    </li>
  );
}

export default async function ModulesPage() {
  const user = await requireUser();
  const admin = user.role !== "TECH";
  const [shop, modules, kinds, hub, priced] = await Promise.all([
    db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { id: true, name: true, sellsRetail: true, timeZone: true } }),
    getModules(user.shopId),
    shopKinds(user.shopId),
    db.hubState.findUnique({ where: { id: 1 }, select: { installKey: true } }),
    db.serviceItem.findMany({ where: { shopId: user.shopId, active: true, priceCents: { gt: 0 }, equipmentKind: { not: null } }, select: { equipmentKind: true } }),
  ]);
  const pricedKinds = new Set(priced.map((s) => s.equipmentKind));
  const applianceKeys = kinds.all.filter((k) => k.equipment === "APPLIANCE").map((k) => k.key);
  const vacPriced = pricedKinds.has("vacuum");
  const appliancePriced = applianceKeys.some((k) => pricedKinds.has(k));
  const hubJoined = Boolean(hub?.installKey);
  const vac = modules.states.vac;
  const appliance = modules.states.appliance;
  const showStart = admin && (vac.active || appliance.active);
  const shopRef = { id: shop.id, name: shop.name };

  // The admin's email link for a module in this state, or the text while nobody sells modules yet.
  const salesLink = (s: ModuleState) => {
    const kind = s.status === "off" ? "ask" : s.status === "renew" && s.plan !== "y" && s.plan !== "t" ? null : s.status === "on" ? null : "renew";
    if (!kind) return null;
    if (!MODULE_SALES.email) return <span className="muted text-xs">Ask StitchBench about it.</span>;
    const href = salesMailto(kind, s.label, shopRef);
    return href ? (
      <a href={href} className="btn btn-sm">
        {kind === "ask" ? "Ask about" : "Renew"} {s.label}
      </a>
    ) : null;
  };

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title="Modules" back={{ href: "/settings", label: "Settings" }} />

      <Section title="Your company">
        <div className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="label">Company ID</span>
            <span className="mono" data-testid="company-id">
              {shop.id}
            </span>
            <CopyButton text={shop.id} />
          </div>
          <p className="muted">Keys are made for this ID. Give it when you buy or renew.</p>
          <p>Name on keys: {shop.name}</p>
          {modules.testBuild && <p className="pill tone-bad inline-block">Test build: test keys work here</p>}
          {modules.clockBehind && modules.floor && (
            <p className="pill tone-bad inline-block whitespace-normal">
              This computer&apos;s clock says {fmtDateTime(new Date(), shop.timeZone)}, but your newest key was made on{" "}
              {fmtDateTime(new Date(modules.floor.getTime() + 48 * 3_600_000), shop.timeZone)}. Modules count from {fmtDateTime(modules.floor, shop.timeZone)}. Check the date
              and time on this computer.
            </p>
          )}
        </div>
      </Section>

      <Section title="Modules">
        <p className="muted mb-3 text-sm">
          Extra parts of StitchBench you can add, paid monthly or yearly. When one ends, nothing is deleted: you can still look at and export what&apos;s there
          and finish work already in, but new work in it stops. The program itself is licensed through your{" "}
          <Link href={SETTINGS_ACCOUNT_HREF} className="link">
            StitchHub account
          </Link>
          .
        </p>
        <div className="scroll-x">
          <table className="table">
            <thead>
              <tr>
                <th>Module</th>
                <th>Status</th>
                <th>From</th>
                {admin && <th />}
              </tr>
            </thead>
            <tbody>
              {PAID_MODULE_IDS.map((id) => {
                const s = modules.states[id];
                return (
                  <tr key={id}>
                    <td>
                      <div className="font-semibold">{s.label}</div>
                      <div className="muted text-xs">{MODULES[id].blurb}</div>
                    </td>
                    <td>
                      <StatusPill s={s} timeZone={shop.timeZone} />
                      <RenewLine s={s} />
                    </td>
                    <td className="whitespace-nowrap text-sm">
                      {s.source === "admin" ? "Turned on by StitchBench" : s.source === "key" && s.keyId ? `Key ${s.keyId}${s.plan ? ` (${planLabel(s.plan)})` : ""}` : "-"}
                    </td>
                    {admin && <td className="text-right">{salesLink(s)}</td>}
                  </tr>
                );
              })}
              {modules.unknownModules.map((name) => (
                <tr key={`unknown-${name}`}>
                  <td colSpan={admin ? 4 : 3} className="muted text-sm">
                    {name}: needs a newer version of StitchBench
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {showStart && (
        <Section title="Getting started">
          <div className="space-y-4 text-sm">
            {vac.active && (
              <div>
                <div className="label mb-1">Vac Shop</div>
                <ul className="space-y-1">
                  <Check done={shop.sellsRetail} href="/settings#company">
                    Selling vacuums, bags and trade-ins uses the register: turn on &apos;Sells over the counter&apos;
                  </Check>
                  <Check done={vacPriced} href="/settings#services">
                    Price your vacuum services
                  </Check>
                  <Check done={hubJoined} href="/settings#hub">
                    Join the community hub to see and share what fits (the finder)
                  </Check>
                  <li className="flex items-start gap-2">
                    <span aria-hidden className="muted">
                      ○
                    </span>
                    <Link href="/vac/convert" className="link">
                      Vacuums already on file as sewing machines?
                    </Link>
                  </li>
                </ul>
              </div>
            )}
            {appliance.active && (
              <div>
                <div className="label mb-1">Small Appliance Repair</div>
                <ul className="space-y-1">
                  <Check done={appliancePriced} href="/settings#services">
                    Price your appliance services
                  </Check>
                  <li className="flex items-start gap-2">
                    <span aria-hidden className="muted">
                      ○
                    </span>
                    <Link href="/settings/equipment" className="link">
                      What you repair: add your own kinds, and pick what check-in opens on
                    </Link>
                  </li>
                </ul>
              </div>
            )}
          </div>
        </Section>
      )}

      <Section title="Add a license key">
        {admin ? (
          <ActionForm action={activateLicense} reset success="Key added" className="space-y-2">
            <label htmlFor="license-key" className="label">
              Paste the key from your email (or the whole email)
            </label>
            <textarea id="license-key" name="key" rows={4} className="textarea mono" placeholder="SB1.eyJ2Ijox…" required />
            <div className="flex flex-wrap items-center gap-3">
              <Submit>Add key</Submit>
            </div>
            <p className="muted text-xs">{MODULE_SALES_NOTE}</p>
          </ActionForm>
        ) : (
          <p className="muted text-sm">The shop owner or an admin adds keys.</p>
        )}
      </Section>

      {modules.keys.length > 0 && (
        <Section title="Keys on file">
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Modules</th>
                  <th>Plan</th>
                  <th>From – to</th>
                  <th>Grace until</th>
                  <th>Added</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {modules.keys.map((k) => (
                  <tr key={k.rowId}>
                    <td className="mono">{k.keyId}</td>
                    <td>{k.modules.map((m) => MODULES[m as keyof typeof MODULES]?.label ?? m).join(", ") || "-"}</td>
                    <td>{planLabel(k.plan) || "-"}</td>
                    <td className="whitespace-nowrap">{k.from && k.lastDay ? `${fmtYmd(k.from)} – ${fmtYmd(k.lastDay)}` : "-"}</td>
                    <td className="whitespace-nowrap">{k.graceLastDay ? fmtYmd(k.graceLastDay) : "-"}</td>
                    <td className="whitespace-nowrap text-xs">
                      {k.source === "hub" ? "From StitchHub (with the sync)" : (k.addedBy ?? "-")}
                      <div className="muted">{fmtDateTime(k.addedAt, shop.timeZone)}</div>
                    </td>
                    <td>
                      <KeyStatePill k={k} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted mt-2 text-xs">Old keys stay here as the history. Removing one can&apos;t give anything back.</p>
        </Section>
      )}

      <p className="muted text-sm">
        Moved to a new computer by restoring a backup? Your keys come with it. Started fresh on a new computer, or moved from the hosted StitchBench? Send us the
        new Company ID for a new key.
      </p>
    </div>
  );
}
