import { PageHeader } from "@/components/ui";
import { Scanner } from "@/components/scanner";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";

export default async function ScanPage({ searchParams }: { searchParams: Promise<{ brand?: string; model?: string }> }) {
  await requireUser();
  const sp = await searchParams;
  const brands = await db.tensionSpec.findMany({ distinct: ["brand"], select: { brand: true }, orderBy: { brand: "asc" } });
  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader
        title="Scan a manual"
        sub="Photograph a paper manual page by page (or add images from a flatbed scanner), and save it as one PDF in your own manuals folder."
      />
      <Scanner brands={brands.map((b) => b.brand)} initialBrand={sp.brand ?? ""} initialModel={sp.model ?? ""} />
    </div>
  );
}
