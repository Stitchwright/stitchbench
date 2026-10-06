import { requireUser } from "@/lib/session";
import { entryFor } from "@/lib/assistant/ui";
import { PageHeader } from "@/components/ui";
import { ImportItems } from "@/components/import-items";

export default async function ImportPage() {
  const user = await requireUser();
  const entry = await entryFor(user.shopId, "parts");
  return (
    <div className="max-w-5xl space-y-4">
      <PageHeader
        back={{ href: "/parts", label: "Inventory" }}
        title="Import items from a spreadsheet"
        sub="A supplier's line sheet, a distributor's order file, or your old system's export: open it in Excel, select the cells (with the header row), copy, and paste below. Or open a CSV file."
      />
      <ImportItems assist={entry.show ? { unavailable: entry.unavailable } : null} />
    </div>
  );
}
