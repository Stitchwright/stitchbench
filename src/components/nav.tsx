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
  Link2,
  MessagesSquare,
  Store,
  ShoppingCart,
  Wrench,
  Handshake,
  type LucideIcon,
} from "lucide-react";

type Item = { href: string; label: string; icon: LucideIcon; repair?: boolean; retail?: boolean; partners?: boolean };

// repair: shown to repair benches; retail: to shops with a counter; partners: to shops with partner shops. Unmarked: everyone.
const items: Item[] = [
  { href: "/register", label: "Register", icon: ShoppingCart, retail: true },
  { href: "/", label: "Dashboard", icon: LayoutDashboard, repair: true },
  { href: "/tickets", label: "Tickets", icon: ClipboardList, repair: true },
  { href: "/repairs", label: "Repairs", icon: Wrench, retail: true, partners: true },
  { href: "/invoices", label: "Invoices", icon: FileText, repair: true },
  { href: "/machines", label: "Machines", icon: Cog, repair: true },
  { href: "/customers", label: "Customers", icon: Users },
  { href: "/parts", label: "Parts", icon: Package },
  { href: "/partners", label: "Partner shops", icon: Handshake },
  { href: "/market", label: "Marketplace", icon: Store, repair: true },
  { href: "/specs", label: "Factory specs", icon: Gauge, repair: true },
  { href: "/shared", label: "Shared by techs", icon: Share2, repair: true },
  { href: "/links", label: "Manual links", icon: Link2, repair: true },
  { href: "/manuals", label: "My manuals", icon: BookOpen, repair: true },
  { href: "/scan", label: "Scan a manual", icon: ScanLine, repair: true },
  { href: "/price-list", label: "Price list", icon: Tags, repair: true },
  { href: "/sales", label: "Sales log", icon: Receipt, repair: true },
  { href: "/register/sales", label: "Register sales", icon: Receipt, retail: true },
  { href: "/settings", label: "Settings", icon: Settings },
];
const platformItems: Item[] = [{ href: "/companies", label: "Companies", icon: Building2 }];

export function Nav({
  platformAdmin = false,
  chatUrl,
  doesRepair = true,
  sellsRetail = false,
  retailPartners = false,
}: {
  platformAdmin?: boolean;
  chatUrl?: string | null;
  doesRepair?: boolean;
  sellsRetail?: boolean;
  retailPartners?: boolean;
}) {
  const path = usePathname();
  const shown = items
    .filter((i) => (!i.repair && !i.retail) || (i.repair && doesRepair) || (i.retail && sellsRetail && (!i.partners || retailPartners)))
    .map((i) => (i.href === "/parts" && !doesRepair ? { ...i, label: "Inventory" } : i));
  // The most specific menu entry wins (/register/sales over /register).
  const activeHref = [...shown, ...platformItems]
    .filter((i) => (i.href === "/" ? path === "/" : path === i.href || path.startsWith(i.href + "/")))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return (
    <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-visible md:pb-0" aria-label="Main">
      {chatUrl && (
        // The community's Discord (from the community hub); opens in the Discord app or the browser.
        <a
          href={chatUrl}
          target="_blank"
          rel="noreferrer"
          className="flex shrink-0 items-center gap-2 rounded px-3 py-2 text-sm font-semibold text-ink-2 hover:bg-surface-2 hover:text-ink md:order-last"
        >
          <MessagesSquare size={16} aria-hidden />
          Community chat
        </a>
      )}
      {[...shown, ...(platformAdmin ? platformItems : [])].map(({ href, label, icon: Icon }) => {
          const active = href === activeHref;
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
