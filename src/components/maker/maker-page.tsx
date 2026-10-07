// The frame every /maker page shares (shop-features-round-2-design.md section 6, the Maker Shop module): the module
// gate, the header and the tabs. Like the Vac Shop's frame (src/components/vac/vac-page.tsx).
import Link from "next/link";
import { db } from "@/lib/db";
import type { CurrentUser } from "@/lib/session";
import { pageGate } from "@/lib/module-info";
import { getModules } from "@/lib/modules";
import { ModuleNotice } from "@/components/module-notice";
import { PageHeader } from "@/components/ui";

export type MakerTab = "home" | "supplies" | "jobs" | "space";

const TABS: { key: MakerTab; href: string; label: string }[] = [
  { key: "home", href: "/maker", label: "Maker Shop" },
  { key: "space", href: "/maker/space", label: "Maker-space time" },
  { key: "supplies", href: "/maker/supplies", label: "Supplies due" },
];

export async function makerPageState(user: CurrentUser, hasRecords = false) {
  const [mods, shop] = await Promise.all([getModules(user.shopId), db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { id: true, name: true, sellsRetail: true } })]);
  const state = mods.states.maker;
  return { state, shop, gate: pageGate(state, hasRecords), admin: user.role !== "TECH" };
}

export function MakerFrame({
  title,
  sub,
  tab,
  state,
  shop,
  gate,
  admin,
  what,
  actions,
  children,
}: {
  title: string;
  sub?: React.ReactNode;
  tab: MakerTab;
  state: Awaited<ReturnType<typeof makerPageState>>["state"];
  shop: { id: string; name: string; sellsRetail: boolean };
  gate: "write" | "read" | "none";
  admin: boolean;
  what?: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  if (gate === "none") {
    return (
      <div className="space-y-4">
        <PageHeader title={title} />
        <ModuleNotice state={state} admin={admin} shop={shop} />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <PageHeader title={title} sub={sub} actions={actions} />
      <nav className="flex flex-wrap gap-2" aria-label="Maker Shop">
        {TABS.map((t) => (
          <Link key={t.key} href={t.href} className={`btn btn-sm ${t.key === tab ? "btn-primary" : ""}`} aria-current={t.key === tab ? "page" : undefined}>
            {t.label}
          </Link>
        ))}
      </nav>
      {gate === "read" && <ModuleNotice state={state} what={what} admin={admin} shop={shop} />}
      {children}
    </div>
  );
}
