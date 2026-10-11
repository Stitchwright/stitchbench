// What a page says when its module is off or switched off (modules-design.md section 6.6). Server components. The five
// trade modules are free and switched on in Settings → Features; the Assistant is added on the StitchHub account.
import Link from "next/link";
import { endedDay, fmtYmd, isFeatureId, MODULES, SETTINGS_ACCOUNT_HREF, SETTINGS_FEATURES_HREF, type ModuleId, type ModuleState } from "@/lib/module-info";
import { getModules } from "@/lib/modules";

/** Where an owner or admin gets the module: Settings → Features (free), or the StitchHub account (the Assistant). */
function GetIt({ state, again }: { state: ModuleState; again?: boolean }) {
  if (isFeatureId(state.id)) {
    return (
      <span>
        {again ? "To start new work, switch it on again in " : "It's free: switch it on in "}
        <Link href={SETTINGS_FEATURES_HREF} className="link">
          Settings → Features
        </Link>
        .
      </span>
    );
  }
  return (
    <span>
      Add it on your{" "}
      <Link href={SETTINGS_ACCOUNT_HREF} className="link">
        StitchHub account
      </Link>
      .
    </span>
  );
}

/** A card for an off or switched-off module; null while it is active. `what` names the page's records ("Your vacuums for sale"). */
export function ModuleNotice({ state, what, admin = false }: { state: ModuleState; what?: string; admin?: boolean }) {
  if (state.active) return null;
  const { label, blurb } = MODULES[state.id];
  const feature = isFeatureId(state.id);
  if (state.status === "lapsed") {
    return (
      <div className="card card-pad text-sm" role="status">
        <p>
          <strong>{state.switchedOff ? `${label} was switched off on ${endedDay(state)}.` : `${label} ended on ${endedDay(state)}.`}</strong> {what ?? "Everything here"} stays here to look at
          and export{feature ? ", and work that came in before then can be finished" : ""}.
        </p>
        <p className="mt-2">{admin ? <GetIt state={state} again /> : feature ? "Ask the shop owner or an admin to switch it on again." : "Ask the shop owner about it."}</p>
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
  return (
    <div className="card card-pad text-sm" role="status">
      <p>
        <strong>{feature ? `${label} isn't switched on for this company.` : `${label} isn't turned on for this company.`}</strong> {blurb}
      </p>
      <p className="mt-2">{admin ? <GetIt state={state} /> : feature ? "Ask the shop owner or an admin to switch it on in Settings → Features." : "Ask the shop owner about it."}</p>
    </div>
  );
}

/** The same, loading its own state. */
export async function ModuleNoticeFor({ shopId, module, what, admin }: { shopId: string; module: ModuleId; what?: string; admin?: boolean }) {
  const mods = await getModules(shopId);
  return <ModuleNotice state={mods.states[module]} what={what} admin={admin} />;
}
