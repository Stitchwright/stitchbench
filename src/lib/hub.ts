import "server-only";
// This install's connection to StitchHub, the community server (see the stitchhub project).
// Sync pushes what this shop shared, then pulls every change since last time into the local copy
// (ManualLink, HubPost, HubPhoto, HubFigure). Pictures are fetched the first time someone looks at them.
import { db } from "@/lib/db";
import { UserError } from "@/lib/action";
import type { NoteKind, PhotoKind } from "@/generated/prisma/enums";

export type HubLink = {
  id: string;
  category: string | null;
  brand: string;
  models: string;
  modelKeys: string[];
  docType: string | null;
  title: string;
  fileName: string | null;
  url: string;
  source: string | null;
  status: string;
  httpStatus: number | null;
  checkedAt: string | null;
  deleted: boolean;
  updatedAt: string;
};

type HubPostIn = {
  id: string;
  shopName: string;
  authorName: string | null;
  brand: string;
  model: string;
  modelKey: string;
  kind: NoteKind;
  title: string;
  body: string;
  deleted: boolean;
  mine: boolean;
  createdAt: string;
  photos: { id: string; kind: PhotoKind; caption: string | null; mime: string; sortOrder: number }[];
};

export type LinkRevision = {
  id: string;
  action: string;
  brand: string;
  models: string;
  docType: string | null;
  title: string;
  url: string;
  byName: string | null;
  byShop: string | null;
  note: string | null;
  createdAt: string;
};

export async function hubState() {
  return db.hubState.findUnique({ where: { id: 1 } });
}

export async function hubJoined() {
  const s = await hubState();
  return Boolean(s?.url && s.installKey);
}

async function reach(url: string, init: RequestInit) {
  try {
    return await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000) });
  } catch {
    throw new UserError("Couldn't reach the community hub. Check the internet connection and try again.");
  }
}

async function failure(r: Response) {
  let msg = `The community hub answered ${r.status}.`;
  try {
    const j = (await r.json()) as { error?: string };
    if (j.error) msg = j.error;
  } catch {
    /* not JSON */
  }
  return new UserError(msg);
}

export async function hubFetch(path: string, init: RequestInit & { json?: unknown } = {}) {
  const s = await hubState();
  if (!s?.url || !s.installKey) throw new UserError("Join the community hub first (Settings → Community hub).");
  const { json, ...rest } = init;
  const r = await reach(s.url + path, {
    ...rest,
    headers: { Authorization: `Bearer ${s.installKey}`, ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (!r.ok) throw await failure(r);
  return r;
}

export type Invite = { url: string; joinKey: string; name?: string | null; discord?: string | null };

/** A member invite from the hub admin: the "stitchhub:..." code, or the .stitchhub file's contents. */
export function parseInvite(text: string): Invite {
  const t = text.trim();
  let json = t;
  if (t.startsWith("stitchhub:")) {
    try {
      json = Buffer.from(t.slice("stitchhub:".length).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    } catch {
      throw new UserError("That invite code is damaged. Copy it again from the hub's invite.");
    }
  }
  let inv: Partial<Invite>;
  try {
    inv = JSON.parse(json) as Partial<Invite>;
  } catch {
    throw new UserError("That isn't a StitchHub invite. Paste the whole code (it starts with stitchhub:) or open the .stitchhub file.");
  }
  if (!inv.url || !inv.joinKey) throw new UserError("That invite is missing the hub address or join key.");
  const discord = inv.discord && /^https:\/\/(discord\.gg|discord\.com\/invite)\/[\w-]+$/.test(inv.discord) ? inv.discord : null;
  return { url: inv.url, joinKey: inv.joinKey, name: inv.name ?? null, discord };
}

export async function joinHub(url: string, joinKey: string, shopName: string, contact?: string | null) {
  const base = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+/.test(base)) throw new UserError("The hub address starts with https://");
  const r = await reach(`${base}/v1/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ joinKey: joinKey.trim(), name: shopName, contact }),
  });
  if (!r.ok) throw await failure(r);
  const j = (await r.json()) as { installId: string; installKey: string; hubName: string };
  const data = { url: base, hubName: j.hubName, installId: j.installId, installKey: j.installKey, joinedAt: new Date(), cursor: "0", lastError: null };
  await db.hubState.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
  return j;
}

export async function leaveHub() {
  await db.hubState.updateMany({ where: { id: 1 }, data: { url: null, installId: null, installKey: null, cursor: null, discordUrl: null } });
}

function linkRow(l: HubLink) {
  return {
    category: l.category,
    brand: l.brand,
    models: l.models,
    modelKeys: l.modelKeys,
    docType: l.docType,
    title: l.title,
    fileName: l.fileName,
    url: l.url,
    source: l.source,
    status: l.status,
    httpStatus: l.httpStatus,
    checkedAt: l.checkedAt ? new Date(l.checkedAt) : null,
    updatedAt: new Date(l.updatedAt),
  };
}

/** Keep the local copy in step with a link the hub just returned. */
export async function saveLink(l: HubLink) {
  if (l.deleted) {
    await db.manualLink.deleteMany({ where: { id: l.id } });
    return;
  }
  await db.manualLink.upsert({ where: { id: l.id }, create: { id: l.id, ...linkRow(l) }, update: linkRow(l) });
}

async function savePost(p: HubPostIn) {
  if (p.deleted) {
    await db.hubPost.deleteMany({ where: { id: p.id } });
    return;
  }
  const row = {
    shopName: p.shopName,
    authorName: p.authorName,
    brand: p.brand,
    model: p.model,
    modelKey: p.modelKey,
    kind: p.kind,
    title: p.title,
    body: p.body,
    mine: p.mine,
    createdAt: new Date(p.createdAt),
  };
  await db.hubPost.upsert({ where: { id: p.id }, create: { id: p.id, ...row }, update: row });
  await db.hubPhoto.deleteMany({ where: { postId: p.id, id: { notIn: p.photos.map((ph) => ph.id) } } });
  for (const ph of p.photos) {
    const meta = { kind: ph.kind, caption: ph.caption, mime: ph.mime, sortOrder: ph.sortOrder };
    await db.hubPhoto.upsert({ where: { id: ph.id }, create: { id: ph.id, postId: p.id, ...meta }, update: meta });
  }
}

/** Send notes this shop shared that the hub doesn't have yet. */
async function pushPending() {
  const pending = await db.sharedPost.findMany({
    where: { hubId: null },
    include: { photos: { orderBy: { sortOrder: "asc" } }, author: { select: { name: true } } },
    take: 50,
  });
  for (const p of pending) {
    const fd = new FormData();
    fd.set(
      "post",
      JSON.stringify({
        brand: p.brand,
        model: p.model,
        kind: p.kind,
        title: p.title,
        body: p.body,
        authorName: p.author?.name ?? null,
        photos: p.photos.map((ph) => ({ kind: ph.kind, caption: ph.caption })),
      }),
    );
    for (const ph of p.photos) fd.append("photo", new Blob([new Uint8Array(ph.data)], { type: ph.mime }), "photo.jpg");
    const { id } = (await (await hubFetch("/v1/posts", { method: "POST", body: fd })).json()) as { id: string };
    await db.sharedPost.update({ where: { id: p.id }, data: { hubId: id } });
  }
  return pending.length;
}

export type SyncResult = { pushed: number; links: number; posts: number; figures: number } | { skipped: true };

async function doSync(): Promise<SyncResult> {
  const s = await hubState();
  if (!s?.url || !s.installKey) return { skipped: true };
  try {
    // The hub's name and Discord link can change; keep them current.
    const me = (await (await hubFetch("/v1/me")).json()) as { hubName?: string; discordInvite?: string | null };
    // The hub's Discord link wins when it has one; otherwise keep the one that came with the invite.
    await db.hubState.update({ where: { id: 1 }, data: { hubName: me.hubName ?? null, ...(me.discordInvite ? { discordUrl: me.discordInvite } : {}) } });
    const pushed = await pushPending();
    const n = { pushed, links: 0, posts: 0, figures: 0 };
    let since = s.cursor ?? "0";
    for (let page = 0; page < 500; page++) {
      const ch = (await (await hubFetch(`/v1/changes?since=${since}&limit=1000`)).json()) as {
        links: HubLink[];
        posts: HubPostIn[];
        figures: string[];
        next: string;
        more: boolean;
      };
      for (const l of ch.links) await saveLink(l);
      for (const p of ch.posts) await savePost(p);
      if (ch.figures.length) await db.hubFigure.createMany({ data: ch.figures.map((id) => ({ id })), skipDuplicates: true });
      n.links += ch.links.length;
      n.posts += ch.posts.length;
      n.figures += ch.figures.length;
      since = String(ch.next);
      await db.hubState.update({ where: { id: 1 }, data: { cursor: since } });
      if (!ch.more) break;
    }
    await db.hubState.update({ where: { id: 1 }, data: { lastSyncAt: new Date(), lastError: null } });
    return n;
  } catch (e) {
    await db.hubState.update({ where: { id: 1 }, data: { lastError: e instanceof Error ? e.message : String(e) } }).catch(() => {});
    throw e;
  }
}

let running: Promise<SyncResult> | null = null;

/** One sync at a time; a second caller waits for the one already running. */
export function syncHub(): Promise<SyncResult> {
  running ??= doSync().finally(() => {
    running = null;
  });
  return running;
}

/** A picture from the hub (note photo or figure snapshot), kept locally after the first look. */
export async function hubPicture(kind: "photo" | "figure", id: string): Promise<{ mime: string; data: Uint8Array } | null> {
  if (kind === "photo") {
    const p = await db.hubPhoto.findUnique({ where: { id }, select: { mime: true, data: true } });
    if (!p) return null;
    if (p.data) return { mime: p.mime, data: p.data };
    const r = await hubFetch(`/v1/photos/${id}`);
    const data = new Uint8Array(await r.arrayBuffer());
    await db.hubPhoto.update({ where: { id }, data: { data } });
    return { mime: p.mime, data };
  }
  const f = await db.hubFigure.findUnique({ where: { id } });
  if (!f) return null;
  if (f.data && f.mime) return { mime: f.mime, data: f.data };
  const r = await hubFetch(`/v1/figures/${id}`);
  const mime = r.headers.get("content-type") ?? "image/jpeg";
  const data = new Uint8Array(await r.arrayBuffer());
  await db.hubFigure.update({ where: { id }, data: { mime, data } });
  return { mime, data };
}

/** Offer a figure snapshot this install made to the hub (ignored when not joined). */
export async function shareFigure(id: string, mime: string, data: Uint8Array, width?: number, height?: number) {
  if (!(await hubJoined())) return;
  const bytes = new Uint8Array(data);
  await hubFetch(`/v1/figures/${id}?w=${width ?? ""}&h=${height ?? ""}`, { method: "PUT", body: new Blob([bytes], { type: mime }), headers: { "Content-Type": mime } });
  await db.hubFigure.upsert({ where: { id }, create: { id, mime, data: bytes }, update: {} });
}
