import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { modelKey } from "@/lib/format";
import { hubJoined } from "@/lib/hub";
import { libraryDir } from "@/lib/library-dir";
import { PageHeader, Empty } from "@/components/ui";
import { ManualLinkItem } from "@/components/manual-links";

const FILTERS = [
  { key: "", label: "All" },
  { key: "ok", label: "Working" },
  { key: "dead", label: "Dead" },
  { key: "blocked", label: "Check in a browser" },
  { key: "unchecked", label: "Not checked yet" },
] as const;

export default async function LinksPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  await requireUser();
  const sp = await searchParams;
  const term = sp.q?.trim() ?? "";
  const status = FILTERS.some((f) => f.key === sp.status) ? sp.status : "";
  const key = modelKey(term);
  const where = {
    ...(status ? { status } : {}),
    ...(term
      ? {
          OR: [
            { brand: { contains: term, mode: "insensitive" as const } },
            { models: { contains: term, mode: "insensitive" as const } },
            { title: { contains: term, mode: "insensitive" as const } },
            { source: { contains: term, mode: "insensitive" as const } },
            ...(key.length >= 2 ? [{ modelKeys: { has: key } }] : []),
          ],
        }
      : {}),
  };
  const [joined, links, total, counts] = await Promise.all([
    hubJoined(),
    db.manualLink.findMany({ where, orderBy: [{ brand: "asc" }, { models: "asc" }, { docType: "asc" }], take: 200 }),
    db.manualLink.count({ where }),
    db.manualLink.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  const n = Object.fromEntries(counts.map((c) => [c.status, c._count._all]));
  const canDownload = libraryDir() != null;
  const qs = (s: string) => `/links?${new URLSearchParams({ ...(term ? { q: term } : {}), ...(s ? { status: s } : {}) })}`;

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader
        title="Manual links"
        sub="Where manuals can be downloaded, shared by every shop on the community hub. Links only: nobody hosts the manuals. Anyone can fix a dead link, and every change can be rolled back."
      />
      {!joined ? (
        <p className="pill tone-wait inline-block">
          Not connected to the community hub. <Link href="/settings#hub" className="link">Join it in Settings</Link> to get the shared link catalog.
        </p>
      ) : (
        <>
          <nav className="flex flex-wrap gap-2" aria-label="Link status">
            {FILTERS.map((f) => (
              <Link key={f.key} href={qs(f.key)} className={`btn btn-sm ${status === f.key ? "btn-primary" : ""}`} aria-current={status === f.key ? "page" : undefined}>
                {f.label}
                {f.key && <span className="num opacity-80">{n[f.key] ?? 0}</span>}
              </Link>
            ))}
          </nav>
          <form className="flex gap-2">
            {status && <input type="hidden" name="status" value={status} />}
            <label htmlFor="lq" className="sr-only">
              Search links
            </label>
            <input id="lq" name="q" defaultValue={term} className="input max-w-md" placeholder="Model, brand or site, e.g. PR655, Juki, supsew" />
            <button className="btn">Search</button>
          </form>
          <div className="card card-pad">
            {links.length === 0 ? (
              <Empty>No links match.</Empty>
            ) : (
              <>
                <p className="muted text-xs">{total > links.length ? `Showing ${links.length} of ${total}. Search to narrow it down.` : `${total} links`}</p>
                <ul className="divide-y divide-line">
                  {links.map((l) => (
                    <ManualLinkItem key={l.id} l={l} canDownload={canDownload} showModel />
                  ))}
                </ul>
              </>
            )}
          </div>
          <p className="muted text-sm">To add a link, open the machine or model page and use &ldquo;Add a link&rdquo; under Manual links.</p>
        </>
      )}
    </div>
  );
}
