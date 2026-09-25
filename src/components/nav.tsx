"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  ClipboardList,
  Cog,
  Package,
  Users,
  Gauge,
  BookOpen,
  ScanLine,
  Receipt,
  Settings,
  FileText,
  Tags,
  Share2,
  Building2,
} from "lucide-react";

const items = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/tickets", label: "Tickets", icon: ClipboardList },
  { href: "/invoices", label: "Invoices", icon: FileText },
  { href: "/machines", label: "Machines", icon: Cog },
  { href: "/customers", label: "Customers", icon: Users },
  { href: "/parts", label: "Parts", icon: Package },
  { href: "/specs", label: "Factory specs", icon: Gauge },
  { href: "/shared", label: "Shared by techs", icon: Share2 },
  { href: "/manuals", label: "My manuals", icon: BookOpen },
  { href: "/scan", label: "Scan a manual", icon: ScanLine },
  { href: "/price-list", label: "Price list", icon: Tags },
  { href: "/sales", label: "Sales log", icon: Receipt },
  { href: "/settings", label: "Settings", icon: Settings },
];
const platformItems = [{ href: "/companies", label: "Companies", icon: Building2 }];

export function Nav({ platformAdmin = false }: { platformAdmin?: boolean }) {
  const path = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-visible md:pb-0" aria-label="Main">
      {[...items, ...(platformAdmin ? platformItems : [])].map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? path === "/" : path === href || path.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`flex shrink-0 items-center gap-2 rounded px-3 py-2 text-sm font-semibold ${
                active ? "bg-navy text-navy-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink"
              }`}
            >
              <Icon size={16} aria-hidden />
              {label}
            </Link>
          );
        })}
    </nav>
  );
}
