import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { addDays, dayStart, parseYmd } from "@/lib/zoned";
import { auditEntries } from "@/lib/audit";
import { AUDIT_ACTIONS, AUDIT_CATEGORIES, CATEGORY_LABEL, auditLabel } from "@/lib/audit-list";
import { PageHeader } from "@/components/ui";

const PAGE_SIZE = 100;

type Sp = { user?: string; category?: string; action?: string; from?: string; to?: string; type?: string; id?: string; page?: string };

/** "before -> after" for a change as written in the log, money fields shown as dollars. */
function changeText(field: string, v: [unknown, unknown]) {
  const show = (x: unknown) => (x == null || x === "" ? "none" : /cents$/i.test(field) && typeof x === "number" ? money(x) : String(x));
  return `${field}: ${show(v[0])} → ${show(v[1])}`;
}

/** Settings → Audit log: who did what to money, prices, stock and people. Owners and admins only; entries are never edited. */
export default async function AuditLog({ searchParams }: { searchParams: Promise<Sp> }) {
  const user = await requireUser();
  if (user.role === "TECH") notFound();
  const sp = await searchParams;
  const tz = await shopTimeZone(user.shopId);
  const from = parseYmd(sp.from);
  const to = parseYmd(sp.to);
  const page = Math.max(1, Math.floor(Number(sp.page) || 1));
  const category = AUDIT_CATEGORIES.find((c) => c === sp.category);
  const action = sp.action && sp.action in AUDIT_ACTIONS ? sp.action : undefined;
  const people = await db.user.findMany({ where: { shopId: user.shopId }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  const userId = people.find((p) => p.id === sp.user)?.id;
  const subjectType = sp.type && /^[A-Za-z]{1,30}$/.test(sp.type) ? sp.type : undefined;
  const subjectId = subjectType && sp.id && /^[A-Za-z0-9_-]{1,40}$/.test(sp.id) ? sp.id : undefined;
  const { rows, total } = await auditEntries(
    user.shopId,
    { userId, category, action, subjectType, subjectId, from: from ? dayStart(from, tz) : undefined, to: to ? dayStart(addDays(to, 1), tz) : undefined },
    { take: PAGE_SIZE, skip: (page - 1) * PAGE_SIZE },
  );
  const when = (d: Date) => d.toLocaleString("en-US", { timeZone: tz, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  const query = (p: number) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ user: userId, category, action, from, to, type: subjectType, id: subjectId })) if (v) q.set(k, v);
    if (p > 1) q.set("page", String(p));
    return `/settings/audit${q.size ? `?${q}` : ""}`;
  };

  return (
    <div className="space-y-4">
      <PageHeader
        back={{ href: "/settings", label: "Settings" }}
        title="Audit log"
        sub="Who changed money, prices, stock, people and permissions, and when. Entries can't be edited or deleted; sign-ins are kept a year, everything else seven."
        actions={
          // A file download, not a page: a plain link.
          // eslint-disable-next-line @next/next/no-html-link-for-pages
          <a href="/api/export/audit" className="btn">
            Download CSV
          </a>
        }
      />
      <form method="get" className="card card-pad flex flex-wrap items-end gap-3" aria-label="Filter the audit log">
        {subjectType && subjectId && (
          <>
            <input type="hidden" name="type" value={subjectType} />
            <input type="hidden" name="id" value={subjectId} />
          </>
        )}
        <div className="field">
          <label htmlFor="user" className="label">
            Person
          </label>
          <select id="user" name="user" className="select" defaultValue={userId ?? ""}>
            <option value="">Everyone</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="category" className="label">
            Category
          </label>
          <select id="category" name="category" className="select" defaultValue={category ?? ""}>
            <option value="">All</option>
            {AUDIT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="action" className="label">
            What
          </label>
          <select id="action" name="action" className="select" defaultValue={action ?? ""}>
            <option value="">Anything</option>
            {Object.entries(AUDIT_ACTIONS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="from" className="label">
            From
          </label>
          <input id="from" name="from" type="date" defaultValue={from ?? ""} className="input" />
        </div>
        <div className="field">
          <label htmlFor="to" className="label">
            To
          </label>
          <input id="to" name="to" type="date" defaultValue={to ?? ""} className="input" />
        </div>
        <button className="btn btn-primary">Show</button>
        {(userId || category || action || from || to || subjectType) && (
          <Link href="/settings/audit" className="link text-sm">
            Clear filters
          </Link>
        )}
      </form>
      {subjectType && subjectId && <p className="pill tone-neutral">History of one {subjectType.toLowerCase()}</p>}
      <p className="muted text-sm">
        {total === 0 ? "Nothing matches." : `${total.toLocaleString("en-US")} ${total === 1 ? "entry" : "entries"}, newest first.`}
      </p>
      {rows.length > 0 && (
        <div className="card overflow-x-auto">
          <table className="table w-full text-sm">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>What</th>
                <th>About</th>
                <th className="text-right">Amount</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const changes = r.changes && typeof r.changes === "object" && !Array.isArray(r.changes) ? Object.entries(r.changes as Record<string, [unknown, unknown]>) : [];
                return (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap">{when(r.at)}</td>
                    <td>
                      {r.userName}
                      {r.role && <span className="muted"> ({r.role.toLowerCase()})</span>}
                    </td>
                    <td>{auditLabel(r.action)}</td>
                    <td>{r.subjectLabel ?? r.subjectType}</td>
                    <td className="num text-right">{r.amountCents != null ? money(r.amountCents) : ""}</td>
                    <td className="text-xs">
                      {changes.map(([f, v]) => (
                        <div key={f}>{changeText(f, v)}</div>
                      ))}
                      {r.reason && <div className="muted">Reason: {r.reason}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {total > PAGE_SIZE && (
        <div className="flex items-center gap-3 text-sm">
          {page > 1 && (
            <Link href={query(page - 1)} className="btn btn-sm">
              Newer
            </Link>
          )}
          <span className="muted">
            Page {page} of {Math.ceil(total / PAGE_SIZE)}
          </span>
          {page * PAGE_SIZE < total && (
            <Link href={query(page + 1)} className="btn btn-sm">
              Older
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
