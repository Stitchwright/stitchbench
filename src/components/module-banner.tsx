"use client";

// Renewal reminders in the layout (modules-design.md section 5.4): a quiet pill for admins when a module is near its
// end, and a banner for everyone while a module is in its grace period. Client component for usePathname.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SETTINGS_ACCOUNT_HREF, SETTINGS_MODULES_HREF } from "@/lib/module-info";

/** `base`: the program itself (hub-accounts-billing-design.md 3.5), whose key comes from Settings → Account, not Modules. */
export type RenewPill = { id: string; label: string; lastDay: string; base?: boolean };
export type GraceItem = { label: string; lastDay: string; graceLastDay: string; daysLeft: number; renewHref: string | null; base?: boolean };

/** "{label} ends {Sep 30}" under the nav, admins only. */
export function ModulePills({ items }: { items: RenewPill[] }) {
  if (!items.length) return null;
  return (
    <div className="no-print flex flex-wrap gap-1 px-4 pb-2">
      {items.map((p) => (
        <Link key={p.id} href={p.base ? SETTINGS_ACCOUNT_HREF : SETTINGS_MODULES_HREF} className="pill tone-wait text-xs" title="Renewal reminder">
          {p.label} ends {p.lastDay}
        </Link>
      ))}
    </div>
  );
}

/** One strip per module in grace, at the top of the page. Hidden for techs on the register, which faces customers. */
export function GraceBanner({ items, admin }: { items: GraceItem[]; admin: boolean }) {
  const path = usePathname();
  if (!items.length) return null;
  if (!admin && path.startsWith("/register")) return null;
  return (
    <div className="no-print mb-4 space-y-2">
      {items.map((g) => (
        <div key={g.label} className={`card card-pad text-sm ${g.daysLeft <= 3 ? "tone-bad" : "tone-wait"}`} role="status">
          <strong>
            {g.label} ended on {g.lastDay}. It keeps working until {g.graceLastDay}.
          </strong>{" "}
          {!admin ? (
            "Let the shop owner know."
          ) : g.base ? (
            <>
              After that it is read-only until a new key arrives. See{" "}
              <Link href={SETTINGS_ACCOUNT_HREF} className="underline">
                Settings → Account
              </Link>
              .
            </>
          ) : (
            <>
              Paste your renewal key in{" "}
              <Link href={SETTINGS_MODULES_HREF} className="underline">
                Settings → Modules
              </Link>
              .
              {g.renewHref && (
                <>
                  {" "}
                  <a href={g.renewHref} className="underline">
                    Renew {g.label}
                  </a>
                </>
              )}
            </>
          )}
        </div>
      ))}
    </div>
  );
}

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
 * The program itself has lapsed (hub-accounts-billing-design.md 3.5): one bar at the top of every page, for every role,
 * saying what still works and where the key comes from. The nav keeps every item: the pages are read-only.
 */
export function LapsedBar({ program, since, admin }: { program: string; since: string; admin: boolean }) {
  return (
    <div className="no-print card card-pad tone-bad mb-4 text-sm" role="status" data-testid="lapsed-bar">
      <strong>
        {program} for this company is read-only since {since}.
      </strong>{" "}
      You can look at and export everything, finish open work and take payments; new tickets, sales and edits wait for a new key.{" "}
      {admin ? (
        <>
          Subscribe or check your standing in{" "}
          <Link href={SETTINGS_ACCOUNT_HREF} className="underline">
            Settings → Account
          </Link>
          .
        </>
      ) : (
        "Let the shop owner know."
      )}
    </div>
  );
}
