// Machines for sale moved to /units for every shop (tax-machine-sales-layaway-design.md section 3): old links and
// bookmarks to the Vac Shop's "For sale" land there, with their tab and search.
import { permanentRedirect } from "next/navigation";

export default async function OldVacUnits({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const keep = new URLSearchParams();
  for (const k of ["tab", "q"]) {
    const v = sp[k];
    if (typeof v === "string" && v) keep.set(k, v);
  }
  const qs = keep.toString();
  permanentRedirect(`/units${qs ? `?${qs}` : ""}`);
}
