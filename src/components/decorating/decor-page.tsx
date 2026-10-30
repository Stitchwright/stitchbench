// The frame every /decorating page shares (docs/plans/decorators-proposal.md): the module gate and the header. Like the Maker
// Shop's (src/components/maker/maker-page.tsx), without tabs: the module has one list and the order pages under it.
import { db } from "@/lib/db";
import type { CurrentUser } from "@/lib/session";
import { pageGate } from "@/lib/module-info";
import { getModules } from "@/lib/modules";
import { ModuleNotice } from "@/components/module-notice";
import { PageHeader } from "@/components/ui";

export async function decorPageState(user: CurrentUser, hasRecords = false) {
  const [mods, shop] = await Promise.all([getModules(user.shopId), db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { id: true, name: true, sellsRetail: true } })]);
  const state = mods.states.decorating;
  return { state, shop, gate: pageGate(state, hasRecords), admin: user.role !== "TECH" };
}

export function DecorFrame({
  title,
  sub,
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
  state: Awaited<ReturnType<typeof decorPageState>>["state"];
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
      {gate === "read" && <ModuleNotice state={state} what={what} admin={admin} shop={shop} />}
      {children}
    </div>
  );
}
