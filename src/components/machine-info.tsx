import { ExternalLink } from "lucide-react";
import { quickLinks } from "@/lib/quick-links";

type Picture = { id: string; sourcePath: string; page: number; width: number; height: number } | null;

/** The machine's picture (cut from its own manual) and one-tap links for this model. */
export function MachineInfo({ brand, model, picture, category }: { brand: string; model: string; picture: Picture; category?: string | null }) {
  const links = quickLinks(brand, model, category);
  const groups = [...new Set(links.map((l) => l.group))];
  return (
    <div className="grid gap-4 sm:grid-cols-[minmax(0,220px)_1fr]">
      <div>
        {picture ? (
          <a href={`/api/model-images/${picture.id}`} target="_blank" rel="noreferrer" className="block">
            {/* eslint-disable-next-line @next/next/no-img-element -- authenticated image route */}
            <img
              src={`/api/model-images/${picture.id}`}
              alt={`${brand} ${model}`}
              width={picture.width}
              height={picture.height}
              className="max-h-56 w-auto max-w-full rounded border border-line bg-white object-contain"
            />
          </a>
        ) : (
          <div className="muted flex h-32 items-center justify-center rounded border border-dashed border-line text-xs">No picture in the library</div>
        )}
        {picture && (
          <div className="muted mt-1 truncate text-xs" title={picture.sourcePath}>
            From {picture.sourcePath.split("\\").pop()}, p. {picture.page}
          </div>
        )}
      </div>
      <div className="space-y-2">
        {groups.map((g) => (
          <div key={g}>
            <div className="label mb-1">{g}</div>
            <div className="flex flex-wrap gap-1.5">
              {links
                .filter((l) => l.group === g)
                .map((l) => (
                  <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="btn btn-sm">
                    {l.label} <ExternalLink size={11} aria-hidden />
                  </a>
                ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
