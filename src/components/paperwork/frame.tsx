// The frame every /paperwork page shares (shop-features-round-2-design.md section 9, dealer paperwork): the header and
// the tabs. Each tab is one kind of record the shop keeps with makers, consignors and staff.
import Link from "next/link";
import { PageHeader } from "@/components/ui";

export type PaperTab = "warranty" | "coop" | "consign" | "commissions" | "accounts";

const TABS: { key: PaperTab; href: string; label: string; admin?: boolean }[] = [
  { key: "warranty", href: "/paperwork/warranty", label: "Warranty claims" },
  { key: "coop", href: "/paperwork/coop", label: "Co-op and rebates" },
  { key: "consign", href: "/paperwork/consign", label: "Consigned machines" },
];

export function PaperFrame({
  title,
  sub,
  tab,
  admin,
  hide = [],
  actions,
  back,
  children,
}: {
  title: string;
  sub?: React.ReactNode;
  tab: PaperTab;
  admin: boolean;
  /** Tabs this company doesn't use (house accounts while they are off). */
  hide?: PaperTab[];
  actions?: React.ReactNode;
  back?: { href: string; label: string };
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-4">
      <PageHeader title={title} sub={sub} actions={actions} back={back} />
      <nav className="no-print flex flex-wrap gap-2" aria-label="Paperwork">
        {TABS.filter((t) => (admin || !t.admin) && !hide.includes(t.key)).map((t) => (
          <Link key={t.key} href={t.href} className={`btn btn-sm ${t.key === tab ? "btn-primary" : ""}`} aria-current={t.key === tab ? "page" : undefined}>
            {t.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
