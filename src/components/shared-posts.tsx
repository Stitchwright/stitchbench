// Notes and photos techs have shared with every shop on StitchBench.
import Link from "next/link";
import { Trash2 } from "lucide-react";
import { db } from "@/lib/db";
import { fmtDate, modelKey } from "@/lib/format";
import { PHOTO_KIND_LABEL } from "@/lib/constants";
import { isPlatformAdmin } from "@/lib/shops";
import type { CurrentUser } from "@/lib/session";
import type { Prisma } from "@/generated/prisma/client";
import type { NoteKind } from "@/generated/prisma/enums";
import { Section, Empty, modelHref } from "@/components/ui";
import { ActionButton } from "@/components/action-form";
import { deleteSharedPost } from "@/actions/shared";

export const SHARE_KIND_LABEL: Record<NoteKind, string> = { GOTCHA: "Issue found", TIP: "Fix / tip", FACT: "Fact" };
const TONE: Record<NoteKind, string> = { GOTCHA: "tone-bad", TIP: "tone-ready", FACT: "tone-neutral" };

const include = {
  photos: { select: { id: true, kind: true, caption: true }, orderBy: { sortOrder: "asc" } },
  author: { select: { name: true } },
  shop: { select: { name: true } },
} satisfies Prisma.SharedPostInclude;
type Post = Prisma.SharedPostGetPayload<{ include: typeof include }>;

export async function findSharedPosts(where: Prisma.SharedPostWhereInput, take = 50) {
  return db.sharedPost.findMany({ where, include, orderBy: { createdAt: "desc" }, take });
}

export function SharedPostList({ posts, user, showModel }: { posts: Post[]; user: CurrentUser; showModel?: boolean }) {
  const admin = isPlatformAdmin(user.email);
  return (
    <ul className="space-y-5">
      {posts.map((p) => {
        const canRemove = admin || (p.shopId === user.shopId && (p.authorId === user.id || user.role !== "TECH"));
        return (
          <li key={p.id} className="border-b border-line pb-4 last:border-0 last:pb-0">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <span className={`pill ${TONE[p.kind]}`}>{SHARE_KIND_LABEL[p.kind]}</span>{" "}
                <strong>{p.title}</strong>
                {showModel && (
                  <>
                    {" · "}
                    <Link href={modelHref(p.brand, p.model)} className="link">
                      {p.brand} {p.model}
                    </Link>
                  </>
                )}
              </div>
              {canRemove && (
                <ActionButton action={deleteSharedPost.bind(null, p.id)} className="btn btn-sm btn-danger" confirm="Stop sharing this with everyone?" success="Removed" title="Remove">
                  <Trash2 size={12} aria-label="Remove" />
                </ActionButton>
              )}
            </div>
            <p className="mt-1 text-sm whitespace-pre-wrap">{p.body}</p>
            {p.photos.length > 0 && (
              <ul className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
                {p.photos.map((ph) => (
                  <li key={ph.id}>
                    <a href={`/api/shared-photos/${ph.id}`} target="_blank" rel="noreferrer" className="block overflow-hidden rounded border border-line">
                      {/* eslint-disable-next-line @next/next/no-img-element -- authenticated route, not a static asset */}
                      <img src={`/api/shared-photos/${ph.id}`} alt={ph.caption ?? PHOTO_KIND_LABEL[ph.kind]} className="aspect-square w-full object-cover" loading="lazy" />
                    </a>
                    {ph.caption && <p className="mt-1 text-xs">{ph.caption}</p>}
                  </li>
                ))}
              </ul>
            )}
            <p className="muted mt-2 text-xs">
              {p.author?.name ?? "A tech"} · {p.shop.name} · {fmtDate(p.createdAt)}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

export async function SharedPosts({ user, brand, model, title }: { user: CurrentUser; brand: string; model: string; title: string }) {
  const posts = await findSharedPosts({ modelKey: modelKey(model), brand: { equals: brand, mode: "insensitive" } });
  return (
    <Section title={`${title} (${posts.length})`}>
      {posts.length === 0 ? (
        <Empty>Nothing shared for this model yet. Use &ldquo;Share with other techs&rdquo; on a machine page to post what you found, with photos.</Empty>
      ) : (
        <SharedPostList posts={posts} user={user} />
      )}
    </Section>
  );
}
