import { PageHeader } from "@/components/ui";
import { ManualLibrary } from "@/components/manual-library";

export default function ManualsPage() {
  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title="My manuals"
        sub="Your manuals stay on this PC or laptop. StitchBench only remembers the folder and the file names, in this browser, so it can match them to machines and open them."
      />
      <ManualLibrary />
    </div>
  );
}
