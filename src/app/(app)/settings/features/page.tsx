// Settings → Features (free-software-design.md section 7, decision 6): every add-on is free, and an owner or admin
// switches each one on or off for the company. Off until chosen, so the screens stay simple. Switching one off deletes
// nothing: its records stay to look at and export, and work already in can be finished. Below the list, the first
// steps for the two kinds of repair that need setting up (modules-design.md section 7).
import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate } from "@/lib/format";
import { FROM_KEYS, getModules } from "@/lib/modules";
import { shopKinds } from "@/lib/equipment/shop";
import { FEATURE_IDS, MODULES, programName, SETTINGS_ACCOUNT_HREF } from "@/lib/module-info";
import { PageHeader, Section } from "@/components/ui";
import { ActionButton } from "@/components/action-form";
import { setFeature } from "@/actions/features";

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

export default async function FeaturesPage() {
  const user = await requireUser();
  const admin = user.role !== "TECH";
  const [shop, modules, kinds, hub, priced, rows] = await Promise.all([
    db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { sellsRetail: true, timeZone: true } }),
    getModules(user.shopId),
    shopKinds(user.shopId),
    db.hubState.findUnique({ where: { id: 1 }, select: { installKey: true } }),
    db.serviceItem.findMany({ where: { shopId: user.shopId, active: true, priceCents: { gt: 0 }, equipmentKind: { not: null } }, select: { equipmentKind: true } }),
    db.shopFeature.findMany({ where: { shopId: user.shopId }, select: { module: true, enabled: true, changedAt: true, byName: true } }),
  ]);
  const changed = new Map(rows.map((r) => [r.module, r]));
  const pricedKinds = new Set(priced.map((s) => s.equipmentKind));
  const applianceKeys = kinds.all.filter((k) => k.equipment === "APPLIANCE").map((k) => k.key);
  const vacPriced = pricedKinds.has("vacuum");
  const appliancePriced = applianceKeys.some((k) => pricedKinds.has(k));
  const hubJoined = Boolean(hub?.installKey);
  const vac = modules.states.vac;
  const appliance = modules.states.appliance;
  const showStart = admin && (vac.active || appliance.active);
  const assistant = modules.states.assistant;

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title="Features" sub={`Extra parts of ${programName()} for the work your shop does. They are all free: switch on the ones you use.`} back={{ href: "/settings", label: "Settings" }} />

      <Section title="Features">
        <p className="muted mb-3 text-sm">
          Switching one off deletes nothing: what is already there stays to look at and export (its menu item stays, read-only), and work that came in before can be
          finished. Switch it on again any time.
          {!admin && " The shop owner or an admin switches these on and off."}
        </p>
        <ul className="divide-y divide-line">
          {FEATURE_IDS.map((id) => {
            const s = modules.states[id];
            const row = changed.get(id);
            return (
              <li key={id} className="flex flex-wrap items-center justify-between gap-3 py-3" data-testid={`feature-${id}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-base font-semibold">{s.label}</span>
                    <span className={`pill ${s.active ? "tone-ready" : "tone-neutral"}`}>{s.active ? "On" : "Off"}</span>
                  </div>
                  <p className="muted text-sm">{MODULES[id].blurb}</p>
                  {row && (
                    <p className="muted text-xs">
                      {row.enabled ? "Switched on" : "Switched off"} {fmtDate(row.changedAt, shop.timeZone)}
                      {/* Carried over at the update to 1.8 (src/lib/modules.ts), or switched here by a person. */}
                      {row.byName === FROM_KEYS ? ", as your license keys had it" : row.byName ? ` by ${row.byName}` : ""}
                    </p>
                  )}
                </div>
                {admin && (
                  <ActionButton action={setFeature.bind(null, id, !s.active)} className="btn" success={s.active ? `${s.label} switched off` : `${s.label} switched on`}>
                    {s.active ? `Switch off ${s.label}` : `Switch on ${s.label}`}
                  </ActionButton>
                )}
              </li>
            );
          })}
        </ul>
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
                    Join StitchHub to see and share what fits (the finder)
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

      <Section title="The Assistant">
        <div className="space-y-2 text-sm">
          <p className="muted">{MODULES.assistant.blurb}</p>
          {assistant.active ? (
            <p>
              On for this company.{" "}
              <Link href="/settings/assistant" className="link">
                Its switches, and what was sent
              </Link>
            </p>
          ) : (
            <p>
              Unlike the features above, the Assistant costs money to run (each question goes to an AI service), so it is paid for on the shop&apos;s StitchHub account.{" "}
              {admin ? (
                <>
                  Add it on{" "}
                  <Link href={SETTINGS_ACCOUNT_HREF} className="link">
                    your StitchHub account
                  </Link>
                  .
                </>
              ) : (
                "Ask the shop owner about it."
              )}
            </p>
          )}
        </div>
      </Section>
    </div>
  );
}
