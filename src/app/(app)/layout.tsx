import Link from "next/link";
import { requireUser, sessionUser } from "@/lib/session";
import { endEverySession } from "@/lib/sign-in";
import { db } from "@/lib/db";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { DEFAULT_TIME_ZONE } from "@/lib/time-zone";
import { Nav } from "@/components/nav";
import { signOut } from "@/auth";
import { appName, isPlatformAdmin } from "@/lib/shops";
import { hubOfflineSince } from "@/lib/hub";
import { getModules } from "@/lib/modules";
import { endedDay, fmtYmd, MODULE_IDS, salesMailto, toNavGates } from "@/lib/module-info";
import { gates as dataGates } from "@/lib/module-gate";
import { messagingView } from "@/lib/messaging/settings";
import { GraceBanner, LapsedBar, ModulePills, MovingBar, PartnershipNotice, type GraceItem, type RenewPill } from "@/components/module-banner";
import { SECURE_ADDRESS_META, secureAddress } from "@/lib/secure-address";
import { deleteFrom } from "@/lib/move/format";
import { partnershipNotice } from "@/lib/hub-standing";
import { AppHeader } from "@/components/app-header";
import { HubResetPrompt } from "@/components/hub-reset-prompt";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [shop, hub, retailPartners, modules] = await Promise.all([
    db.shop.findUnique({ where: { id: user.shopId }, select: { id: true, name: true, doesRepair: true, sellsRetail: true, timeZone: true, hubStanding: true, hubStandingUntil: true, hubStandingNote: true } }),
    db.hubState.findUnique({ where: { id: 1 }, select: { discordUrl: true, installKey: true, scope: true } }),
    db.partnerLink.count({ where: { shopId: user.shopId, side: "retail" } }),
    getModules(user.shopId),
  ]);
  const doesRepair = shop?.doesRepair ?? true;
  const admin = user.role !== "TECH";
  // Nav gates: the modules' own state, then Scheduling / Marketing as the data says (a company with records of a
  // module that ended still sees the item, read-only).
  const gates = { ...toNavGates(modules), ...(await dataGates(user.shopId)) };
  // Marketing, unless hidden: customer replies nobody has handled (the Messages badge) and a paused channel (the pill).
  const [replies, ms] =
    gates.marketing !== "hidden" ? await Promise.all([db.inboundText.count({ where: { shopId: user.shopId, keyword: null, handledAt: null } }), messagingView(user.shopId)]) : [0, null];
  const pausePill = ms?.emailPausedAt ? "Email paused: fix in Settings" : ms?.smsPausedAt ? "Texts paused: fix in Settings" : null;
  // The hub stopped answering (the internet is down, most likely): say so once, quietly. Everything local keeps working.
  const offline = hub?.installKey ? hubOfflineSince() : null;
  // Paid modules: a quiet renewal pill for admins, and a banner for everyone while a module is in its grace period.
  // Layouts don't re-render on navigation, so these may be one navigation stale; the pages and actions are the real gates.
  const shopRef = { id: user.shopId, name: shop?.name ?? "" };
  const pills: RenewPill[] = admin
    ? MODULE_IDS.filter((id) => modules.states[id].status === "renew").map((id) => ({
        id,
        label: modules.states[id].label,
        lastDay: fmtYmd(modules.states[id].lastDay ?? "").replace(/, \d{4}$/, ""),
        base: id === "base",
      }))
    : [];
  const grace: GraceItem[] = MODULE_IDS.filter((id) => modules.states[id].status === "grace").map((id) => {
    const s = modules.states[id];
    const graceEnd = s.graceLastDay ? Date.parse(`${s.graceLastDay}T23:59:59Z`) : modules.now.getTime();
    return {
      label: s.label,
      lastDay: fmtYmd(s.lastDay ?? ""),
      graceLastDay: fmtYmd(s.graceLastDay ?? ""),
      daysLeft: Math.max(0, Math.ceil((graceEnd - modules.now.getTime()) / 86_400_000)),
      renewHref: id === "base" ? null : salesMailto("renew", s.label, shopRef),
      base: id === "base",
    };
  });
  // The program itself has lapsed (hub-accounts-billing-design.md 3.5): a bar on every page for every role; the nav
  // keeps every item, since the pages are read-only.
  const base = modules.states.base;
  const lapsedSince = base.status === "lapsed" ? endedDay(base) : null;

  // The shop's https address for tablets (the Windows program's SECURE_URL), for the camera and copy buttons to name on a
  // plain-http page (src/components/secure-page.tsx). React hoists the tag into <head>. This layout renders per request
  // (requireUser), so the value is the running program's, not the build's.
  const secureUrl = secureAddress();

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      {secureUrl && <meta name={SECURE_ADDRESS_META} content={secureUrl} />}
      <aside className="no-print border-b border-line bg-surface md:sticky md:top-0 md:h-screen md:overflow-y-auto md:w-60 md:shrink-0 md:border-r md:border-b-0">
        <AppHeader
          logo={
          <Link href="/" className="block">
            <div className="text-lg font-bold leading-tight tracking-tight">
              Stitch<span className="text-thread">{appName() === "StitchShop" || !doesRepair ? "Shop" : "Bench"}</span>
            </div>
            <div className="muted truncate text-xs">{shop?.name}</div>
          </Link>
        }
          search={
        <form action="/search" className="md:px-0 md:pb-3 md:pt-0">
          <label htmlFor="q" className="sr-only">
            Search
          </label>
          <input id="q" name="q" className="input text-sm" placeholder={doesRepair ? "Serial, model, customer, ticket #" : "Customer, item, tag #"} />
        </form>
          }
        >
        <Nav
          platformAdmin={isPlatformAdmin(user.email)}
          chatUrl={hub?.installKey && hub.scope === "member" ? hub.discordUrl : null}
          doesRepair={doesRepair}
          sellsRetail={shop?.sellsRetail ?? false}
          retailPartners={retailPartners > 0}
          showReports={user.role !== "TECH"}
          gates={gates}
          badges={{ "/messages": replies }}
          pausePill={pausePill}
        />
        <ModulePills items={pills} />
        {offline && (
          <div className="px-4 pb-2">
            <span
              className="pill tone-wait text-xs"
              title="Sharing, the marketplace and messages to partner shops wait until the connection is back. Tickets, the register, customers and parts work as usual."
            >
              Offline since {fmtDateTime(new Date(offline), shop?.timeZone ?? DEFAULT_TIME_ZONE, { hour: "numeric", minute: "2-digit" })}
            </span>
          </div>
        )}
        {/* On phones too: a shared counter tablet or a tech's phone must be able to sign out. */}
        <div className="px-4 py-2 text-xs md:py-4">
          <div className="muted">Signed in as {user.name}</div>
          <form
            action={async () => {
              "use server";
              // Every device signed in as this login signs out too (sessionVersion + 1), so a copy of the cookie stops
              // working as well (round 3 L42).
              const me = await sessionUser();
              if (me) await endEverySession(me.id);
              await signOut({ redirectTo: "/login" });
            }}
          >
            <button className="link mt-1 text-xs">Sign out</button>
          </form>
        </div>
        </AppHeader>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-5 md:px-8 md:py-8">
        {modules.moving ? (
          <MovingBar
            to={modules.moving.to}
            since={fmtDate(modules.moving.at, shop?.timeZone ?? DEFAULT_TIME_ZONE)}
            movedOn={modules.moving.outAt ? fmtDate(modules.moving.outAt, shop?.timeZone ?? DEFAULT_TIME_ZONE) : null}
            deleteOn={modules.moving.outAt ? fmtDate(deleteFrom(modules.moving.outAt), shop?.timeZone ?? DEFAULT_TIME_ZONE) : null}
            admin={admin}
          />
        ) : (
          lapsedSince && <LapsedBar program={base.label} since={lapsedSince} admin={admin} />
        )}
        <GraceBanner items={grace} admin={admin} />
        {admin && shop && <PartnershipNotice note={partnershipNotice(shop)?.note ?? null} />}
        {children}
      </main>
      {/* The Windows program's own window only: a password reset the owner asked for on their StitchHub account. */}
      <HubResetPrompt />
    </div>
  );
}
