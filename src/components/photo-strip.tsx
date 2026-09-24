import { Trash2 } from "lucide-react";
import { PhotoUpload } from "@/components/photo-upload";
import { ActionButton } from "@/components/action-form";
import { deletePhoto } from "@/actions/records";

type Photo = { id: string; caption: string | null; createdAt: Date; ticketId: string | null };

export function PhotoStrip({ machineId, ticketId, photos }: { machineId: string; ticketId?: string; photos: Photo[] }) {
  return (
    <div className="space-y-3">
      {photos.length === 0 ? (
        <p className="muted text-sm">No photos yet. Snap one at check-in so there&apos;s a record of its condition.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {photos.map((p) => (
            <li key={p.id} className="group relative">
              <a href={`/api/photos/${p.id}`} target="_blank" rel="noreferrer" className="block overflow-hidden rounded border border-line">
                {/* eslint-disable-next-line @next/next/no-img-element -- authenticated route, not a static asset */}
                <img src={`/api/photos/${p.id}`} alt={p.caption ?? "Machine photo"} className="aspect-square w-full object-cover" loading="lazy" />
              </a>
              <div className="mt-1 flex items-center justify-between gap-1">
                <span className="muted text-xs">{p.createdAt.toLocaleDateString()}</span>
                <ActionButton action={deletePhoto.bind(null, p.id)} className="btn btn-sm btn-danger" confirm="Delete?" title="Delete photo">
                  <Trash2 size={12} aria-label="Delete" />
                </ActionButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      <PhotoUpload machineId={machineId} ticketId={ticketId} />
    </div>
  );
}
