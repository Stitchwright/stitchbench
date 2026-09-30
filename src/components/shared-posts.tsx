// Tech notes shared with the community: everything on the hub (synced copy), plus this StitchBench's own notes
// that haven't reached the hub yet (or were shared before it joined one).
import Link from "next/link";
import { Trash2 } from "lucide-react";
import { db } from "@/lib/db";
import { fmtDate, modelKey } from "@/lib/format";
import { PHOTO_KIND_LABEL } from "@/lib/constants";
import { brandMatches } from "@/lib/model-info";
import { hubJoined } from "@/lib/hub";
import { isPlatformAdmin } from "@/lib/shops";
import type { CurrentUser } from "@/lib/session";
import type { ActionResult } from "@/lib/action";
import type { NoteKind, PhotoKind } from "@/generated/prisma/enums";
import { Section, Empty, modelHref } from "@/components/ui";
import { ActionButton } from "@/components/action-form";
import { deleteSharedPost } from "@/actions/shared";
import { removeHubPost } from "@/actions/hub";

export const SHARE_KIND_LABEL: Record<NoteKind, string> = { GOTCHA: "Issue found", TIP: "Fix / tip", FACT: "Fact" };
const TONE: Record<NoteKind, string> = { GOTCHA: "tone-bad", TIP: "tone-ready", FACT: "tone-neutral" };

export type SharedNote = {
  key: string;
  kind: NoteKind;
  title: string;
  body: string;
  brand: string;
  model: string;
  shop: string;
  author: string | null;
  createdAt: Date;
  photos: { src: string; kind: PhotoKind; caption: string | null }[];
  remove?: () => Promise<ActionResult>;
  pending?: string; // shown when it's only in this StitchBench so far
};

type Filter = { brand?: string; model?: string; term?: string; take?: number };

function textWhere(term?: string) {
  if (!term) return {};
  const t = { contains: term, mode: "insensitive" as const };
  return { OR: [{ brand: t }, { model: t }, { title: t }, { body: t }] };
}

/** Community notes, newest first. */
export async function sharedNotes(user: CurrentUser, f: Filter = {}): Promise<SharedNote[]> {
  const take = f.take ?? 50;
  const mk = f.model ? modelKey(f.model) : undefined;
  const joined = await hubJoined();
  const admin = isPlatformAdmin(user.email);
  const [hub, local] = await Promise.all([
    db.hubPost.findMany({
      where: { ...(mk ? { modelKey: mk } : {}), ...textWhere(f.term) },
      include: { photos: { select: { id: true, kind: true, caption: true }, orderBy: { sortOrder: "asc" } } },
      orderBy: { createdAt: "desc" },
      take,
    }),
    db.sharedPost.findMany({
      where: { hubId: null, ...(mk ? { modelKey: mk } : {}), ...textWhere(f.term) },
      include: { photos: { select: { id: true, kind: true, caption: true }, orderBy: { sortOrder: "asc" } }, author: { select: { name: true } }, shop: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take,
    }),
  ]);
  const notes: SharedNote[] = [
    ...hub.map((p) => ({
      key: `h-${p.id}`,
      kind: p.kind,
      title: p.title,
      body: p.body,
      brand: p.brand,
      model: p.model,
      shop: p.shopName,
      author: p.authorName,
      createdAt: p.createdAt,
      photos: p.photos.map((ph) => ({ src: `/api/hub-photos/${ph.id}`, kind: ph.kind, caption: ph.caption })),
      // Shared from this install, and (when the hub says which company shared it) by this company.
      remove: p.mine && (admin || !p.shopRef || p.shopRef === user.shopId) ? removeHubPost.bind(null, p.id) : undefined,
    })),
    ...local.map((p) => ({
      key: `l-${p.id}`,
      kind: p.kind,
      title: p.title,
      body: p.body,
      brand: p.brand,
      model: p.model,
      shop: p.shop.name,
      author: p.author?.name ?? null,
      createdAt: p.createdAt,
      photos: p.photos.map((ph) => ({ src: `/api/shared-photos/${ph.id}`, kind: ph.kind, caption: ph.caption })),
      remove:
        admin || (p.shopId === user.shopId && (p.authorId === user.id || user.role !== "TECH")) ? deleteSharedPost.bind(null, p.id) : undefined,
      pending: joined ? "Sending to the community hub" : "Only in this StitchBench: join the community hub to share it with other shops",
    })),
  ];
  return notes
    .filter((n) => !f.brand || brandMatches(n.brand, f.brand))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, take);
}

export function SharedPostList({ notes, showModel }: { notes: SharedNote[]; showModel?: boolean }) {
  return (
    <ul className="space-y-5">
      {notes.map((p) => (
        <li key={p.key} className="border-b border-line pb-4 last:border-0 last:pb-0">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <span className={`pill ${TONE[p.kind]}`}>{SHARE_KIND_LABEL[p.kind]}</span> <strong>{p.title}</strong>
              {showModel && (
                <>
                  {" · "}
                  <Link href={modelHref(p.brand, p.model)} className="link">
                    {p.brand} {p.model}
                  </Link>
                </>
              )}
            </div>
            {p.remove && (
              <ActionButton action={p.remove} className="btn btn-sm btn-danger" confirm="Stop sharing this?" success="Removed" title="Remove">
                <Trash2 size={12} aria-label="Remove" />
              </ActionButton>
            )}
          </div>
          <p className="mt-1 text-sm whitespace-pre-wrap">{p.body}</p>
          {p.photos.length > 0 && (
            <ul className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
              {p.photos.map((ph) => (
                <li key={ph.src}>
                  <a href={ph.src} target="_blank" rel="noreferrer" className="block overflow-hidden rounded border border-line">
                    {/* eslint-disable-next-line @next/next/no-img-element -- authenticated route, not a static asset */}
                    <img src={ph.src} alt={ph.caption ?? PHOTO_KIND_LABEL[ph.kind]} className="aspect-square w-full object-cover" loading="lazy" />
                  </a>
                  {ph.caption && <p className="mt-1 text-xs">{ph.caption}</p>}
                </li>
              ))}
            </ul>
          )}
          <p className="muted mt-2 text-xs">
            {p.author ?? "A tech"} · {p.shop} · {fmtDate(p.createdAt)}
            {p.pending && <span className="pill tone-wait ml-2">{p.pending}</span>}
          </p>
        </li>
      ))}
    </ul>
  );
}

export async function SharedPosts({ user, brand, model, title }: { user: CurrentUser; brand: string; model: string; title: string }) {
  const notes = await sharedNotes(user, { brand, model });
  return (
    <Section title={`${title} (${notes.length})`}>
      {notes.length === 0 ? (
        <Empty>Nothing shared for this model yet. Use &ldquo;Share with other techs&rdquo; on a machine page to post what you found, with photos.</Empty>
      ) : (
        <SharedPostList notes={notes} />
      )}
    </Section>
  );
}
