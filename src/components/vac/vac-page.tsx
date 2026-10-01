// The frame every /vac page shares (foundation): the module gate, the header, the tabs, and the "selling needs the
// register" card for companies that don't sell over the counter (modules-design.md section 10.0).
import Link from "next/link";
import { db } from "@/lib/db";
import type { CurrentUser } from "@/lib/session";
import { pageGate } from "@/lib/module-info";
import { getModules } from "@/lib/modules";
import { ModuleNotice } from "@/components/module-notice";
import { PageHeader } from "@/components/ui";
import { VacTabs, type VacTab } from "@/components/vac/vac-tabs";

/** The Vac Shop state for a page: the module state, the shop, and the gate (with `hasRecords` for read-only views). */
export async function vacPageState(user: CurrentUser, hasRecords = false) {
  const [mods, shop] = await Promise.all([getModules(user.shopId), db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { id: true, name: true, sellsRetail: true, doesRepair: true } })]);
  const state = mods.states.vac;
  return { state, shop, gate: pageGate(state, hasRecords), admin: user.role !== "TECH" };
}

/** Header + tabs, or the module notice alone when the gate is "none". */
export function VacFrame({ title, sub, tab, state, shop, gate, admin, what, needsRegister = false, children }: {
  title: string;
  sub?: React.ReactNode;
  tab: VacTab | null;
  state: Awaited<ReturnType<typeof vacPageState>>["state"];
  shop: { id: string; name: string; sellsRetail: boolean };
  gate: "write" | "read" | "none";
  admin: boolean;
  what?: string;
  needsRegister?: boolean;
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
      <PageHeader title={title} sub={sub} />
      <VacTabs active={tab} />
      {gate === "read" && <ModuleNotice state={state} what={what} admin={admin} shop={shop} />}
      {needsRegister && !shop.sellsRetail && (
        <p className="card card-pad text-sm">
          Selling vacuums, bags and trade-ins happens at the Register.{" "}
          {admin ? (
            <Link href="/settings#company" className="link">
              Turn on &quot;Sells over the counter&quot; in Settings
            </Link>
          ) : (
            "Ask the shop owner to turn on the register."
          )}
        </p>
      )}
      {children}
    </div>
  );
}
