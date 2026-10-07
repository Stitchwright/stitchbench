// What a page says when its module is off or has ended (modules-design.md section 6.6). Server components.
import Link from "next/link";
import { db } from "@/lib/db";
import { endedDay, fmtYmd, MODULES, salesMailto, SETTINGS_MODULES_HREF, type ModuleId, type ModuleState } from "@/lib/module-info";
import { getModules } from "@/lib/modules";

type Shop = { id: string; name: string };

/** A card for an off or ended module; null while it is active. `what` names the page's records ("Your vacuums for sale"). */
export function ModuleNotice({ state, what, admin = false, shop }: { state: ModuleState; what?: string; admin?: boolean; shop: Shop }) {
  if (state.active) return null;
  const { label, blurb } = MODULES[state.id];
  if (state.status === "lapsed") {
    const renew = salesMailto("renew", label, shop);
    return (
      <div className="card card-pad text-sm" role="status">
        <p>
          <strong>{state.switchedOff ? `${label} was switched off on ${endedDay(state)}.` : `${label} ended on ${endedDay(state)}.`}</strong> {what ?? "Everything here"} stays here to
          look at and export, and work that came in before then can be finished.
        </p>
        {admin ? (
          <p className="mt-2 flex flex-wrap items-center gap-2">
            <span>
              To start new work, renew it in{" "}
              <Link href={SETTINGS_MODULES_HREF} className="link">
                Settings → Add-ons
              </Link>
              .
            </span>
            {renew && (
              <a href={renew} className="btn btn-sm">
                Renew {label}
              </a>
            )}
          </p>
        ) : (
          <p className="mt-2">Ask the shop owner to renew it.</p>
        )}
      </div>
    );
  }
  if (state.startsOn) {
    return (
      <div className="card card-pad text-sm" role="status">
        <strong>
          {label} starts on {fmtYmd(state.startsOn)}.
        </strong>
      </div>
    );
  }
  const ask = salesMailto("ask", label, shop);
  return (
    <div className="card card-pad text-sm" role="status">
      <p>
        <strong>{label} isn&apos;t turned on for this company.</strong> {blurb}
      </p>
      {admin ? (
        <p className="mt-2 flex flex-wrap items-center gap-2">
          <span>
            To add it, see{" "}
            <Link href={SETTINGS_MODULES_HREF} className="link">
              Settings → Add-ons
            </Link>
            .
          </span>
          {ask ? (
            <a href={ask} className="btn btn-sm">
              Ask about {label}
            </a>
          ) : (
            <span className="muted">Ask StitchBench about it.</span>
          )}
        </p>
      ) : (
        <p className="mt-2">Ask the shop owner about it.</p>
      )}
    </div>
  );
}

/** The same, loading its own state and shop. */
export async function ModuleNoticeFor({ shopId, module, what, admin }: { shopId: string; module: ModuleId; what?: string; admin?: boolean }) {
  const [mods, shop] = await Promise.all([getModules(shopId), db.shop.findUnique({ where: { id: shopId }, select: { id: true, name: true } })]);
  if (!shop) return null;
  return <ModuleNotice state={mods.states[module]} what={what} admin={admin} shop={shop} />;
}
