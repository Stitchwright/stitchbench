// The bars at the top of every page while a company is read-only: it is being moved to another install, or (only on
// the owner's hosted service, HOSTING_BILLING=on) its hosting wasn't paid. Nothing else ends: the add-ons are free.
import Link from "next/link";
import { SETTINGS_ACCOUNT_HREF } from "@/lib/module-info";

/**
 * The company is being moved to another install (company-move-design.md section 7): one bar at the top of every page, for
 * every role. Shown instead of the lapsed bar: the move is what the owner did last, and Cancel is what undoes it.
 */
export function MovingBar({ to, since, movedOn, deleteOn, admin }: { to: string | null; since: string; movedOn?: string | null; deleteOn?: string | null; admin: boolean }) {
  // Moved (the hub said so, or the owner did): the old copy, kept read-only until it is deleted by hand after 30 days.
  if (movedOn) {
    return (
      <div className="no-print card card-pad tone-bad mb-4 text-sm" role="status" data-testid="moved-bar">
        <strong>
          This company moved{to ? ` to ${to}` : ""} on {movedOn}. This copy is read-only; delete it after {deleteOn}.
        </strong>{" "}
        Everything here can still be looked at and exported. Work goes on at the new install, where everyone signs in with the same email and password.
      </div>
    );
  }
  return (
    <div className="no-print card card-pad tone-bad mb-4 text-sm" role="status" data-testid="moving-bar">
      <strong>
        This company is moving{to ? ` to ${to}` : ""}; it is read-only here since {since}.
      </strong>{" "}
      You can look at and export everything, finish open work and take payments; nothing new is written here, so nothing is lost on the way.{" "}
      {admin ? (
        <>
          Download the move file, or cancel the move to carry on here, in{" "}
          <Link href="/settings#move" className="underline">
            Settings → Company
          </Link>
          .
        </>
      ) : (
        "Ask the shop owner."
      )}
    </div>
  );
}

/**
 * The hosting wasn't paid (hub-accounts-billing-design.md 3.5; only where HOSTING_BILLING=on): one bar at the top of
 * every page, for every role, saying what still works and the two ways on: pay for the hosting, or take the company to
 * the free Windows program. The nav keeps every item: the pages are read-only.
 */
export function LapsedBar({ program, since, admin }: { program: string; since: string; admin: boolean }) {
  return (
    <div className="no-print card card-pad tone-bad mb-4 text-sm" role="status" data-testid="lapsed-bar">
      <strong>
        {program} for this company is read-only since {since}: its hosting isn&apos;t paid.
      </strong>{" "}
      You can look at and export everything, finish open work and take payments; new tickets, sales and edits wait.{" "}
      {admin ? (
        <>
          Pay for the hosting in{" "}
          <Link href={SETTINGS_ACCOUNT_HREF} className="underline">
            Settings → Account
          </Link>
          , or move the company to the free Windows program from{" "}
          <Link href="/settings#move" className="underline">
            Settings → Company
          </Link>
          .
        </>
      ) : (
        "Let the shop owner know."
      )}
    </div>
  );
}
