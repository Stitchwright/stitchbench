import Link from "next/link";

export type MessagesTab = "outbox" | "replies" | "optouts" | "campaigns";

const TABS: { key: MessagesTab; label: string; href: string }[] = [
  { key: "outbox", label: "Messages", href: "/messages" },
  { key: "replies", label: "Replies", href: "/messages/replies" },
  { key: "optouts", label: "Opt-outs", href: "/messages/opt-outs" },
  { key: "campaigns", label: "Campaigns", href: "/campaigns" },
];

/** The tabs under every Messages page's header; `unhandled` is the count of replies nobody has read yet. */
export function MessagesTabs({ active, unhandled = 0 }: { active: MessagesTab; unhandled?: number }) {
  return (
    <div className="no-print mb-4 flex flex-wrap gap-2 text-sm" role="navigation" aria-label="Messages">
      {TABS.map((t) => (
        <Link key={t.key} href={t.href} className={`btn btn-sm ${active === t.key ? "btn-primary" : ""}`} aria-current={active === t.key ? "page" : undefined}>
          {t.label}
          {t.key === "replies" && unhandled > 0 ? <span className="pill tone-wait">{unhandled}</span> : null}
        </Link>
      ))}
    </div>
  );
}
