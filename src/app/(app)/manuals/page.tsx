import { PageHeader, Section } from "@/components/ui";
import { ManualLibrary } from "@/components/manual-library";
import { libraryDir } from "@/lib/library-dir";
import { canOfferNow } from "@/lib/manual-repository";
import { requireUser } from "@/lib/session";
import { entryFor } from "@/lib/assistant/ui";
import { ManualSearch } from "@/components/assistant/manual-search";
import { ManualsIndexPanel } from "@/components/assistant/manuals-index-panel";

export default async function ManualsPage() {
  const user = await requireUser();
  // Hosted (no library on the server): the browser sends a chosen file itself. On the shop PC the server's own library does it (model page, Manual links).
  const canOffer = !libraryDir() && (await canOfferNow(user));
  // The search index is the Assistant's (ai-assistant-scope.md 1.4): only where its manuals feature can work, and only for
  // the library on this PC. The company chooses to index; nothing is read until the button is pressed.
  const search = libraryDir() && (await entryFor(user.shopId, "manuals")).show;
  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title="My manuals"
        sub="Your manuals stay on this PC or laptop. StitchBench only remembers the folder and the file names, in this browser, so it can match them to machines and open them."
      />
      {search && (
        <Section title="Search inside the manuals">
          <div className="space-y-3">
            <ManualSearch />
            <ManualsIndexPanel shopId={user.shopId} scope={{ all: true }} admin={user.role !== "TECH"} />
          </div>
        </Section>
      )}
      <ManualLibrary canOffer={canOffer} />
    </div>
  );
}
