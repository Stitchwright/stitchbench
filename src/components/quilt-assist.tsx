"use client";
// The quilt planner's helpers (shop-features-round-2-design.md 5.3): "Suggest coordinates" (the Assistant picks from the
// shop's own shelf for the parts still empty, with a reason each; the program has already checked every pick has the
// yards) and "Thread to match" (no Assistant: threads on the shelf whose swatch or color words match each fabric).
import { useState, useTransition } from "react";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import { suggestCoordinates } from "@/actions/assistant";
import { threadsToMatch } from "@/actions/quilt";
import { runAction } from "@/components/action-form";
import { shrinkImage } from "@/components/photo-upload";
import type { QuiltPickResult } from "@/lib/assistant/quilt";
import type { QuiltRole } from "@/lib/fabric-math";
import { money } from "@/lib/format";
import type { PlannerFabric } from "@/lib/quilt";
import type { ThreadHit } from "@/lib/quilt-thread";

const toBase64 = (blob: Blob) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] ?? "");
    r.onerror = () => rej(new Error("Could not read that photo."));
    r.readAsDataURL(blob);
  });

export function SuggestCoordinates({
  roles,
  picks,
  byId,
  onPicks,
  unavailable,
}: {
  roles: QuiltRole[];
  picks: Record<string, string>;
  byId: Map<string, PlannerFabric>;
  /** The kept picks and their reasons, for the planner to set. */
  onPicks: (picks: { role: string; id: string; why: string }[]) => void;
  unavailable?: string;
}) {
  const [pending, start] = useTransition();
  const focusDefault = roles.find((r) => /focus/i.test(r.role))?.role ?? roles[0]?.role ?? "";
  const [focusRole, setFocusRole] = useState(focusDefault);
  const [photo, setPhoto] = useState<{ blob: Blob; url: string } | null>(null);
  if (unavailable) return <p className="muted text-sm">{unavailable}</p>;
  const role = roles.some((r) => r.role === focusRole) ? focusRole : focusDefault;
  const focus = byId.get(picks[role] ?? "");
  const empty = roles.filter((r) => r.role !== role && !picks[r.role]);
  const run = () =>
    start(async () => {
      const data = photo && !focus ? await toBase64(photo.blob).catch(() => "") : null;
      const r = await runAction(() => suggestCoordinates(focus?.id ?? null, data, "image/jpeg", empty.map((x) => ({ role: x.role, yards: x.yards }))));
      if (r?.error) return void toast.error(r.error);
      if (!r?.shown) return;
      const res = JSON.parse(r.shown) as QuiltPickResult;
      onPicks(res.picks);
      toast.success(res.picks.length ? `Suggested ${res.picks.length} of ${empty.length}. Change any you like.` : "Nothing on the shelf fit well enough. Pick them yourself.");
    });
  return (
    <div className="space-y-2 rounded border border-line p-3" data-suggest-coordinates>
      <div className="flex flex-wrap items-end gap-2 text-sm">
        <div className="field">
          <label htmlFor="q-focus-role" className="label">
            Her focus fabric is the
          </label>
          <select id="q-focus-role" className="select" value={role} onChange={(e) => setFocusRole(e.target.value)}>
            {roles.map((r) => (
              <option key={r.role} value={r.role}>
                {r.role}
              </option>
            ))}
          </select>
        </div>
        {!focus && (
          <div className="field">
            <label htmlFor="q-focus-photo" className="label">
              Or a photo of what she brought
            </label>
            <input
              id="q-focus-photo"
              type="file"
              accept="image/*"
              capture="environment"
              className="input"
              onChange={async (e) => {
                const f = e.currentTarget.files?.[0];
                if (!f) return;
                try {
                  const blob = await shrinkImage(f, 1024, 0.7);
                  setPhoto({ blob, url: URL.createObjectURL(blob) });
                } catch {
                  toast.error("Couldn't open that photo. Try another.");
                }
              }}
            />
          </div>
        )}
        <button type="button" className="btn" disabled={pending || !empty.length || (!focus && !photo)} onClick={run}>
          <Sparkles size={16} aria-hidden /> {pending ? "Looking at the shelf..." : "Suggest coordinates"}
        </button>
      </div>
      <p className="muted text-xs">
        {focus ? `Sends ${focus.name}'s colors and collection` : photo ? "Sends the photo" : `Pick her ${role} fabric first, or add a photo`}, and the names, colors and yards of fabrics on your shelf with enough yards. Never a customer. The
        program checks every suggestion is in stock.
      </p>
    </div>
  );
}

export function ThreadToMatch({ picked, chosen, onChoose }: { picked: PlannerFabric[]; chosen: Record<string, ThreadHit>; onChoose: (t: ThreadHit, on: boolean) => void }) {
  const [pending, start] = useTransition();
  const [hits, setHits] = useState<Record<string, ThreadHit[]> | null>(null);
  const look = () =>
    start(async () => {
      const r = await runAction(() => threadsToMatch(picked.map((f) => f.id)));
      if (r?.error) toast.error(r.error);
      else if (r?.shown) setHits(JSON.parse(r.shown) as Record<string, ThreadHit[]>);
    });
  return (
    <div className="no-print space-y-2 text-sm" data-thread-to-match>
      <button type="button" className="btn btn-sm" disabled={pending || !picked.length} onClick={look}>
        {pending ? "Looking..." : hits ? "Look again" : "Thread to match"}
      </button>
      {hits && (
        <ul className="space-y-2">
          {picked.map((f) => (
            <li key={f.id}>
              <div className="font-medium">{f.name}</div>
              {(hits[f.id] ?? []).length === 0 ? (
                <p className="muted text-xs">No thread on the shelf matches its colors{f.tags.length ? "" : " (it has no color tags yet)"}.</p>
              ) : (
                <ul className="mt-1 flex flex-wrap gap-3">
                  {hits[f.id].map((t) => (
                    <li key={t.id}>
                      <label className="flex min-h-11 items-center gap-2">
                        <input type="checkbox" className="check" checked={!!chosen[t.id]} onChange={(e) => onChoose(t, e.currentTarget.checked)} />
                        <span className="inline-block h-5 w-5 rounded border border-line" style={{ background: t.colorHex ?? undefined }} aria-hidden />
                        {t.name} <span className="muted text-xs">({t.qty} on hand{t.priceCents != null ? `, ${money(t.priceCents)}` : ""})</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
