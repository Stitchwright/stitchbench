import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { defaultShopKind, isPlatformAdmin } from "@/lib/shops";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { NO_END } from "@/lib/license";
import { fmtYmd, MODULE_IDS, MODULES, type ModuleId, type ModuleState } from "@/lib/module-info";
import { grantHistory, isDesktop, loadModulesMany } from "@/lib/modules";
import { hostedSigner } from "@/lib/license-signing";
import { NO_HOSTING_KEY } from "@/lib/modules-admin";
import { PageHeader, Section } from "@/components/ui";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { CopyButton } from "@/components/copy-button";
import { CompanyTimeZoneField } from "@/components/company-timezone-field";
import { createCompany, setCompanyModule, setHubWrites } from "@/actions/companies";
import { recentImports } from "@/lib/move/upload";
import { ImportCompany } from "./import-company";

const SHORT: Record<ModuleId, string> = { base: "Program", vac: "Vac", appliance: "Appliance", scheduling: "Scheduling", marketing: "Marketing" };

/** One short pill for the Modules column, or null when the module is off. */
function modulePill(s: ModuleState) {
  const name = SHORT[s.id];
  const day = s.lastDay ? fmtYmd(s.lastDay) : null;
  switch (s.status) {
    case "on":
    case "renew":
      return { text: s.lastDay && s.lastDay >= NO_END ? `${name} on (no end date)` : `${name} until ${day ?? "-"}`, tone: s.status === "on" ? "ready" : "wait" };
    case "grace":
      return { text: `${name} ended ${day ?? "-"}, grace until ${s.graceLastDay ? fmtYmd(s.graceLastDay) : "-"}`, tone: "bad" };
    case "lapsed":
      return { text: s.switchedOff ? `${name} off (switched)` : `${name} ended ${day ?? "-"}`, tone: "neutral" };
    default:
      return null;
  }
}

/** "Extend 1 month" / "Extend 1 year": a tiny form posting the admin's switch with mode=extend. */
function Extend({ shopId, module, period, canSign }: { shopId: string; module: ModuleId; period: "m" | "y"; canSign: boolean }) {
  return (
    <ActionForm action={setCompanyModule} success="Saved" className="inline">
      <input type="hidden" name="shopId" value={shopId} />
      <input type="hidden" name="module" value={module} />
      <input type="hidden" name="mode" value="extend" />
      <input type="hidden" name="period" value={period} />
      <button type="submit" className="btn btn-sm" disabled={!canSign} title={canSign ? undefined : NO_HOSTING_KEY}>
        Extend 1 {period === "m" ? "month" : "year"}
      </button>
    </ActionForm>
  );
}

// Only the StitchBench admin (PLATFORM_ADMIN_EMAILS) sees this: every company on the system, and a form to add one.
export default async function Companies() {
  const user = await requireUser();
  const tz = await shopTimeZone(user.shopId);
  if (!isPlatformAdmin(user.email)) notFound();
  const shops = await db.shop.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      users: { where: { role: "OWNER" }, select: { name: true, email: true } },
      _count: { select: { users: true, machines: true, tickets: true, sharedPosts: true } },
    },
  });
  const desktop = isDesktop();
  const canSign = !desktop && hostedSigner() != null;
  const [modules, history, imports] = await Promise.all([loadModulesMany(shops.map((s) => s.id)), grantHistory(20), recentImports(user)]);
  const nameOf = new Map(shops.map((s) => [s.id, s.name]));
  const modeText = (mode: string, note: string | null) => (mode === "on" ? (note?.startsWith("Extended") ? "extended" : "on") : mode === "off" ? "off" : "keys decide");

  return (
    <div className="max-w-6xl space-y-6">
      <PageHeader
        title="Companies"
        sub="Each company has its own customers, machines, tickets, prices and people. Only shared notes and the factory specs are seen by everyone."
      />
      <div className="card scroll-x">
        <table className="table">
          <thead>
            <tr>
              <th>Company</th>
              <th>Company ID</th>
              <th>Owner</th>
              <th className="text-right">People</th>
              <th className="text-right">Machines</th>
              <th className="text-right">Tickets</th>
              <th className="text-right">Shared</th>
              <th>Modules</th>
              <th>Hub</th>
              <th>Since</th>
            </tr>
          </thead>
          <tbody>
            {shops.map((s) => {
              const m = modules.get(s.id);
              return (
                <tr key={s.id}>
                  <td className="font-semibold">
                    {s.name}
                    {s.id === user.shopId && <span className="pill tone-neutral ml-2">yours</span>}
                    {s.movedInAt && (
                      <span className="pill tone-neutral ml-2" title={s.movedFrom ?? undefined}>
                        moved in {fmtDate(s.movedInAt, tz)}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap">
                    <span className="mono text-xs">{s.id}</span> <CopyButton text={s.id} />
                  </td>
                  <td>
                    {s.users[0]?.name ?? "-"} <span className="muted text-xs">{s.users[0]?.email}</span>
                  </td>
                  <td className="num text-right">{s._count.users}</td>
                  <td className="num text-right">{s._count.machines}</td>
                  <td className="num text-right">{s._count.tickets}</td>
                  <td className="num text-right">{s._count.sharedPosts}</td>
                  <td>
                    <div className="flex flex-col gap-1">
                      {MODULE_IDS.map((id) => {
                        const st = m?.states[id];
                        const pill = st ? modulePill(st) : null;
                        if (!st || !pill) return null;
                        const extendable = st.source === "admin" && st.lastDay != null && st.lastDay < NO_END && (st.status === "on" || st.status === "renew");
                        return (
                          <div key={id} className="flex flex-wrap items-center gap-1">
                            <span className={`pill tone-${pill.tone} text-xs`}>{pill.text}</span>
                            {extendable && !desktop && (
                              <>
                                <Extend shopId={s.id} module={id} period="m" canSign={canSign} />
                                <Extend shopId={s.id} module={id} period="y" canSign={canSign} />
                              </>
                            )}
                          </div>
                        );
                      })}
                      {m && MODULE_IDS.every((id) => m.states[id].status === "off") && <span className="muted text-xs">-</span>}
                    </div>
                  </td>
                  <td className="whitespace-nowrap">
                    <span className={`pill ${s.hubWritesOff ? "tone-bad" : "tone-ready"} text-xs`}>{s.hubWritesOff ? "Sharing off" : "Sharing on"}</span>{" "}
                    <ActionButton action={setHubWrites.bind(null, s.id, !s.hubWritesOff)} className="btn btn-sm" success={s.hubWritesOff ? "Sharing on" : "Sharing off"}>
                      {s.hubWritesOff ? "Turn sharing on" : "Turn sharing off"}
                    </ActionButton>
                  </td>
                  <td className="num whitespace-nowrap">{fmtDate(s.createdAt, tz)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Section title="Modules for a company">
        {desktop ? (
          <p className="muted text-sm">Modules are switched on from the hosted StitchBench. Here, each company pastes its license key in Settings → Modules.</p>
        ) : (
          <div className="space-y-4">
            <p className="muted text-sm">
              Switch a paid module on or off for one company on this server. &apos;Turn off&apos; stops every key the company had until you choose &apos;Let keys
              decide&apos;. &apos;Let keys decide&apos; removes your switch, so only the company&apos;s own keys count.
            </p>
            {!canSign && <p className="pill tone-wait inline-block whitespace-normal text-sm">{NO_HOSTING_KEY}</p>}
            <ActionForm action={setCompanyModule} success="Saved" className="grid-form">
              <div className="field">
                <label htmlFor="m-shop" className="label">
                  Company
                </label>
                <select id="m-shop" name="shopId" className="select" required>
                  {shops.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="m-module" className="label">
                  Module
                </label>
                <select id="m-module" name="module" className="select" required>
                  {MODULE_IDS.map((id) => (
                    <option key={id} value={id}>
                      {MODULES[id].label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="m-last" className="label">
                  On until (blank: no end date)
                </label>
                <input id="m-last" name="lastDay" type="date" className="input" />
              </div>
              <div className="field">
                <label htmlFor="m-grace" className="label">
                  Days of grace
                </label>
                <input id="m-grace" name="grace" type="number" min={0} max={90} defaultValue={14} className="input num" />
              </div>
              <div className="field sm:col-span-2">
                <label htmlFor="m-note" className="label">
                  Note
                </label>
                <input id="m-note" name="note" className="input" placeholder="e.g. Invoice 1042" maxLength={200} />
              </div>
              <div className="flex flex-wrap gap-2 sm:col-span-2">
                <button type="submit" name="mode" value="on" className="btn btn-primary" disabled={!canSign} title={canSign ? undefined : NO_HOSTING_KEY}>
                  Turn on
                </button>
                <button type="submit" name="mode" value="off" className="btn btn-danger">
                  Turn off
                </button>
                <button type="submit" name="mode" value="none" className="btn">
                  Let keys decide
                </button>
              </div>
            </ActionForm>

            {history.length > 0 && (
              <div className="scroll-x">
                <table className="table text-sm">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Company</th>
                      <th>Module</th>
                      <th>Switch</th>
                      <th>Until</th>
                      <th>By</th>
                      <th>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((h, i) => (
                      <tr key={`${h.at.toISOString()}-${h.shopId}-${h.module}-${i}`}>
                        <td className="num whitespace-nowrap">{fmtDateTime(h.at, tz)}</td>
                        <td>{nameOf.get(h.shopId) ?? <span className="mono text-xs">{h.shopId}</span>}</td>
                        <td>{(MODULES as Record<string, { label: string }>)[h.module]?.label ?? h.module}</td>
                        <td>{modeText(h.mode, h.note)}</td>
                        <td className="whitespace-nowrap">{h.lastDay ? (h.lastDay >= NO_END ? "no end date" : fmtYmd(h.lastDay)) : "-"}</td>
                        <td className="text-xs">{h.byEmail}</td>
                        <td className="text-xs">{h.note ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Section>

      <Section title="Add a company">
        <p className="muted mb-3 text-sm">
          Creates the company and its owner login. Give the owner the temporary password; they sign in, set their prices, and add their own employees under
          Settings → People.
        </p>
        <ActionForm action={createCompany} reset success="Company created" className="grid-form">
          <div className="field">
            <label htmlFor="c-shop" className="label">
              Company name
            </label>
            <input id="c-shop" name="shop" required className="input" />
          </div>
          <div className="field">
            <label htmlFor="c-kind" className="label">
              Kind of shop
            </label>
            <select id="c-kind" name="kind" className="select" defaultValue={defaultShopKind()}>
              <option value="repair">Repair shop (StitchBench)</option>
              <option value="retail">Sewing / quilt shop (StitchShop register)</option>
              <option value="both">Both: repairs and a counter</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="c-name" className="label">
              Owner&apos;s name
            </label>
            <input id="c-name" name="name" required className="input" />
          </div>
          <div className="field">
            <label htmlFor="c-email" className="label">
              Owner&apos;s email (their login)
            </label>
            <input id="c-email" name="email" type="email" required className="input" />
          </div>
          <div className="field">
            <label htmlFor="c-pw" className="label">
              Temporary password (8+ characters)
            </label>
            <input id="c-pw" name="password" required minLength={8} className="input" autoComplete="new-password" />
          </div>
          <CompanyTimeZoneField defaultZone={tz} />
          <div className="field sm:col-span-2">
            <label htmlFor="c-code" className="label">
              Partner code from its repair shop (optional: connects a sewing shop to the repair shop that made the code)
            </label>
            <input id="c-code" name="partnerCode" autoComplete="off" className="input mono" placeholder="7KQP-M2XH-9TRD" />
          </div>
          <div className="sm:col-span-2">
            <Submit>Create company</Submit>
          </div>
        </ActionForm>
      </Section>

      <Section title="Import a company">
        <ImportCompany recent={imports} />
      </Section>
    </div>
  );
}
