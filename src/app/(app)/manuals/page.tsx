import { PageHeader } from "@/components/ui";
import { ManualLibrary } from "@/components/manual-library";
import { libraryDir } from "@/lib/library-dir";
import { canOfferNow } from "@/lib/manual-repository";
import { requireUser } from "@/lib/session";

export default async function ManualsPage() {
  const user = await requireUser();
  // Hosted (no library on the server): the browser sends a chosen file itself. On the shop PC the server's own library does it (model page, Manual links).
  const canOffer = !libraryDir() && (await canOfferNow(user));
  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title="My manuals"
        sub="Your manuals stay on this PC or laptop. StitchBench only remembers the folder and the file names, in this browser, so it can match them to machines and open them."
      />
      <ManualLibrary canOffer={canOffer} />
    </div>
  );
}
