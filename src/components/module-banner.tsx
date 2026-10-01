"use client";

// Renewal reminders in the layout (modules-design.md section 5.4): a quiet pill for admins when a module is near its
// end, and a banner for everyone while a module is in its grace period. Client component for usePathname.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SETTINGS_MODULES_HREF } from "@/lib/module-info";

export type RenewPill = { id: string; label: string; lastDay: string };
export type GraceItem = { label: string; lastDay: string; graceLastDay: string; daysLeft: number; renewHref: string | null };

/** "{label} ends {Sep 30}" under the nav, admins only. */
export function ModulePills({ items }: { items: RenewPill[] }) {
  if (!items.length) return null;
  return (
    <div className="no-print flex flex-wrap gap-1 px-4 pb-2">
      {items.map((p) => (
        <Link key={p.id} href={SETTINGS_MODULES_HREF} className="pill tone-wait text-xs" title="Renewal reminder">
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
          {admin ? (
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
          ) : (
            "Let the shop owner know."
          )}
        </div>
      ))}
    </div>
  );
}
