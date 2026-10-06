/** A fabric's swatch picture (the first photo), or a dashed "no photo" square. */
export function Swatch({ photoId, alt }: { photoId: string | null; alt: string }) {
  return photoId ? (
    // eslint-disable-next-line @next/next/no-img-element -- authenticated route, not a static asset
    <img src={`/api/parts/photo/${photoId}`} alt={`${alt} swatch`} className="h-16 w-16 shrink-0 rounded border border-line object-cover" loading="lazy" />
  ) : (
    <div className="muted flex h-16 w-16 shrink-0 items-center justify-center rounded border border-dashed border-line text-xs" aria-hidden="true">
      no photo
    </div>
  );
}
