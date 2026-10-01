// The calendar's tabs: Day and Week on /calendar, Staff on /shifts (scheduling-messaging-design.md 6.2). Server component.
import Link from "next/link";

export type CalendarTab = "day" | "week" | "staff";

export function CalendarTabs({ active, date }: { active: CalendarTab; date?: string | null }) {
  const q = date ? `&date=${encodeURIComponent(date)}` : "";
  const tabs: { key: CalendarTab; label: string; href: string }[] = [
    { key: "day", label: "Day", href: `/calendar?view=day${q}` },
    { key: "week", label: "Week", href: `/calendar?view=week${q}` },
    { key: "staff", label: "Staff", href: date ? `/shifts?date=${encodeURIComponent(date)}` : "/shifts" },
  ];
  return (
    <nav aria-label="Calendar views" className="no-print flex flex-wrap gap-2">
      {tabs.map((t) => (
        <Link key={t.key} href={t.href} className={`btn btn-sm${t.key === active ? " btn-primary" : ""}`} aria-current={t.key === active ? "page" : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
