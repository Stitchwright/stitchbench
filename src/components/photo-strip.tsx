import { Trash2 } from "lucide-react";
import { PhotoUpload } from "@/components/photo-upload";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { deletePhoto, updatePhoto } from "@/actions/records";
import { PHOTO_KINDS, PHOTO_KIND_LABEL } from "@/lib/constants";
import type { PhotoKind } from "@/generated/prisma/enums";

type Photo = { id: string; caption: string | null; kind: PhotoKind; createdAt: Date; ticketId: string | null };

export const PHOTO_SELECT = { id: true, caption: true, kind: true, createdAt: true, ticketId: true } as const;

export function PhotoStrip({ machineId, ticketId, photos }: { machineId: string; ticketId?: string; photos: Photo[] }) {
  const groups = PHOTO_KINDS.map((k) => ({ kind: k, items: photos.filter((p) => p.kind === k) })).filter((g) => g.items.length);
  return (
    <div className="space-y-4">
      {photos.length === 0 ? (
        <p className="muted text-sm">
          No photos yet. Snap one at check-in so there&apos;s a record of its condition, and photograph connectors before you unplug anything.
        </p>
      ) : (
        groups.map((g) => (
          <div key={g.kind}>
            <h3 className="label mb-2">
              {PHOTO_KIND_LABEL[g.kind]} ({g.items.length})
            </h3>
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {g.items.map((p) => (
                <li key={p.id}>
                  <a href={`/api/photos/${p.id}`} target="_blank" rel="noreferrer" className="block overflow-hidden rounded border border-line">
                    {/* eslint-disable-next-line @next/next/no-img-element -- authenticated route, not a static asset */}
                    <img src={`/api/photos/${p.id}`} alt={p.caption ?? `${PHOTO_KIND_LABEL[p.kind]} photo`} className="aspect-square w-full object-cover" loading="lazy" />
                  </a>
                  {p.caption && <p className="mt-1 text-xs">{p.caption}</p>}
                  <div className="mt-1 flex items-center justify-between gap-1">
                    <span className="muted text-xs">{p.createdAt.toLocaleDateString()}</span>
                    <ActionButton action={deletePhoto.bind(null, p.id)} className="btn btn-sm btn-danger" confirm="Delete?" title="Delete photo">
                      <Trash2 size={12} aria-label="Delete" />
                    </ActionButton>
                  </div>
                  <details className="mt-1 text-xs">
                    <summary className="link cursor-pointer">Edit</summary>
                    <ActionForm action={updatePhoto.bind(null, p.id)} success="Photo updated" className="mt-1 space-y-1">
                      <label className="sr-only" htmlFor={`pk-${p.id}`}>
                        Photo of
                      </label>
                      <select id={`pk-${p.id}`} name="kind" defaultValue={p.kind} className="select text-xs">
                        {PHOTO_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {PHOTO_KIND_LABEL[k]}
                          </option>
                        ))}
                      </select>
                      <label className="sr-only" htmlFor={`pc-${p.id}`}>
                        Caption
                      </label>
                      <input id={`pc-${p.id}`} name="caption" defaultValue={p.caption ?? ""} className="input text-xs" placeholder="Caption" />
                      <Submit className="btn btn-sm">Save</Submit>
                    </ActionForm>
                  </details>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
      <PhotoUpload machineId={machineId} ticketId={ticketId} />
    </div>
  );
}
