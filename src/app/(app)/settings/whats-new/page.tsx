// Settings → What's new: every version's changes for this program (ease-of-use-design.md 2).
import { requireUser } from "@/lib/session";
import { allWhatsNew } from "@/lib/ease";
import { PageHeader, Section } from "@/components/ui";

export default async function WhatsNewPage() {
  await requireUser();
  const entries = allWhatsNew();
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="What's new" sub="What each version added, newest first." />
      {entries.map((e) => (
        <Section key={e.version} title={`Version ${e.version}`} actions={<span className="muted text-sm">{new Date(`${e.date}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}</span>}>
          <ul className="list-disc space-y-2 pl-5 text-base">
            {e.lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </Section>
      ))}
    </div>
  );
}
