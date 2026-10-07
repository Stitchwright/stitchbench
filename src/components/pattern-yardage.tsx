// "Yardage on the back" on a pattern's page (shop-features-round-2-design.md 5.3): typed once from the back of the
// pattern, one size a line; the quilt planner reads it.
import Link from "next/link";
import { patternNeedsText } from "@/lib/fabric-math";
import { patternNeedsFor } from "@/lib/quilt";
import { savePatternYardage } from "@/actions/quilt";
import { ActionForm, Submit } from "@/components/action-form";
import { Section } from "@/components/ui";

export async function PatternYardage({ shopId, partId }: { shopId: string; partId: string }) {
  const needs = await patternNeedsFor(shopId, partId);
  return (
    <Section title="Yardage on the back">
      <ActionForm action={savePatternYardage.bind(null, partId)} className="space-y-3">
        <div className="field">
          <label htmlFor="pattern-needs" className="label">
            One size a line, as the back of the pattern says
          </label>
          <textarea id="pattern-needs" name="needs" rows={4} maxLength={4000} className="input" defaultValue={patternNeedsText(needs)} placeholder={"Throw: background 2 1/4 yd, focus 1 yd, binding 1/2 yd, backing 3 3/4 yd\nQueen: background 4 yd, focus 2 yd, binding 3/4 yd, backing 8 yd"} />
          <p className="muted mt-1 text-xs">The quilt planner works out the pull list from these.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Submit>Save the yardage</Submit>
          {needs.length > 0 && (
            <Link href={`/fabric/quilt?pattern=${partId}`} className="link text-sm">
              Plan a quilt from this pattern
            </Link>
          )}
        </div>
      </ActionForm>
    </Section>
  );
}
