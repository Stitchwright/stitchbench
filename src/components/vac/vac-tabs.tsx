import Link from "next/link";

export type VacTab = "repairs" | "finder" | "units" | "bags-due" | "installs";

const TABS: { key: VacTab; label: string; href: string }[] = [
  { key: "repairs", label: "Repairs", href: "/tickets?kind=vacuum" },
  { key: "finder", label: "Finder", href: "/vac/finder" },
  { key: "units", label: "For sale", href: "/vac/units" },
  { key: "bags-due", label: "Bags due", href: "/vac/bags-due" },
  { key: "installs", label: "Installs", href: "/vac/installs" },
];

/** The Vac Shop tabs, under every /vac page's header. */
export function VacTabs({ active }: { active: VacTab | null }) {
  return (
    <div className="no-print mb-4 flex flex-wrap gap-2 text-sm" role="navigation" aria-label="Vac Shop">
      {TABS.map((t) => (
        <Link key={t.key} href={t.href} className={`btn btn-sm ${active === t.key ? "btn-primary" : ""}`}>
          {t.label}
        </Link>
      ))}
    </div>
  );
}
