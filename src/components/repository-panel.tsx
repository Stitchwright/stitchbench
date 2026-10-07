// The manual repository on the Manual links page: what the hub says about offers (the repository opens soon, or it takes
// them), this company's offers with where each stands, and the files waiting in the library's _inbox, each of which can be
// offered by its own dialog. Offers come only from a person pressing Offer for a file (design section 3).
import fs from "node:fs";
import Link from "next/link";
import { db } from "@/lib/db";
import { fmtDateTime } from "@/lib/format";
import { hubState } from "@/lib/hub";
import { libraryDir, resolveInLibrary } from "@/lib/library-dir";
import { OFFER_WORDS, canOfferNow, offersFor, sizeWords, SOON } from "@/lib/manual-repository";
import type { CurrentUser } from "@/lib/session";
import { Section } from "@/components/ui";
import { OfferForm, docWords } from "@/components/manual-offer";

/** PDFs waiting in <library>\_inbox (first 40), as library-relative paths. */
async function inboxFiles(root: string): Promise<{ path: string; file: string; size: number }[]> {
  try {
    const dir = resolveInLibrary(root, "_inbox\\x.pdf");
    if (!dir) return [];
    const base = dir.replace(/[\\/]x\.pdf$/, "");
    const out: { path: string; file: string; size: number }[] = [];
    for (const e of await fs.promises.readdir(base, { withFileTypes: true })) {
      if (!e.isFile() || !/\.pdf$/i.test(e.name)) continue;
      out.push({ path: `_inbox\\${e.name}`, file: e.name, size: (await fs.promises.stat(`${base}/${e.name}`)).size });
      if (out.length >= 40) break;
    }
    return out.sort((a, b) => a.file.localeCompare(b.file));
  } catch {
    return [];
  }
}

export async function RepositoryPanel({ user, timeZone }: { user: CurrentUser; timeZone: string }) {
  const s = await hubState();
  if (!s?.url || !s.installKey || s.scope !== "member" || s.repoUploads === "none") return null;
  const root = libraryDir();
  const soon = s.repoUploads === "soon";
  const [offers, repoCount, allowed, shop] = await Promise.all([
    offersFor(user.shopId, 50),
    db.manualLink.count({ where: { origin: "repository" } }),
    canOfferNow(user),
    db.shop.findUnique({ where: { id: user.shopId }, select: { techsOfferManuals: true } }),
  ]);
  const inbox = root && allowed ? await inboxFiles(root) : [];
  const categories = inbox.length ? (await db.libraryDoc.findMany({ distinct: ["category"], select: { category: true }, orderBy: { category: "asc" } })).map((c) => c.category) : [];
  return (
    <Section title="Manual repository">
      <div className="space-y-3 text-sm">
        <p className="muted">
          A community library of manuals, free with a StitchHub account. {repoCount.toLocaleString()} {repoCount === 1 ? "manual is" : "manuals are"} in it, listed with the links below; Download puts one in your
          library under its usual name.
        </p>
        {soon && <p className="pill tone-wait inline-block">{SOON} Offering a manual switches on here once it does; nothing is sent until then.</p>}
        {!soon && user.role === "TECH" && !shop?.techsOfferManuals && <p className="muted">Offering manuals is for the shop owner or an admin. The owner can allow techs in Settings → StitchHub.</p>}
        {!soon && allowed && root && (
          <div>
            <div className="label mb-1">Offer a file from the library&apos;s _inbox</div>
            {inbox.length === 0 ? (
              <p className="muted">
                Nothing waiting in _inbox. To offer a filed manual, open its model page and use &ldquo;Offer one of your manuals to the repository&rdquo; under Manual links. Each file is offered on its own, and only when you
                press Offer.
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {inbox.map((f) => (
                  <li key={f.path} className="flex flex-wrap items-start justify-between gap-2 py-2">
                    <span className="min-w-0 break-all">
                      {f.file} <span className="muted text-xs">{sizeWords(f.size)}</span>
                    </span>
                    <OfferForm path={f.path} fileName={f.file} categories={categories} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div>
          <div className="label mb-1">Your company&apos;s offers</div>
          {offers.length === 0 ? (
            <p className="muted">No offers yet.</p>
          ) : (
            <ul className="divide-y divide-line" aria-label="Offers to the repository">
              {offers.map((o) => {
                const w = OFFER_WORDS[o.state] ?? { label: o.state, tone: "tone-neutral" };
                return (
                  <li key={o.id} className="py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold break-all">
                        {o.brand} {o.models}: {docWords(o.docType)}
                      </span>
                      <span className={`pill ${w.tone}`}>{w.label}</span>
                    </div>
                    <div className="muted text-xs">
                      {o.fileName} · {sizeWords(o.sizeBytes)} · offered {fmtDateTime(o.createdAt, timeZone)} by {o.byName}
                    </div>
                    {o.reason && o.state !== "PUBLISHED" && o.state !== "WAITING" && <p className="text-xs">{o.reason}</p>}
                    {o.state === "REMOVED" && (
                      <p className="text-xs">
                        If you believe it was removed by mistake, you can send a counter-notice on{" "}
                        <a href={`${s.url!.replace(/\/+$/, "")}/account/repository`} target="_blank" rel="noreferrer" className="link">
                          your StitchHub account
                        </a>
                        .
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="muted mt-1 text-xs">
            States are refreshed at each sync with the hub. <Link href="/settings#hub" className="link">Update from StitchHub in Settings</Link>.
          </p>
        </div>
      </div>
    </Section>
  );
}
