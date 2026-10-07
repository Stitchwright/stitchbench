// "Same color as" on an item's page (shop-features-round-2-design.md 2.2): the shop's own matches between makers ("same
// as Madeira 1147"), shown in the register's color lookup. The program never guesses them: the shop links each one.
import Link from "next/link";
import { sameAsOf } from "@/lib/colors";
import { linkSameColor, unlinkSameColor } from "@/actions/colors";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { Section } from "@/components/ui";
import { ColorDot } from "@/components/color-dot";

export async function SameColor({ shopId, partId }: { shopId: string; partId: string }) {
  const same = await sameAsOf(shopId, partId);
  return (
    <Section title="Same color as">
      {same.length === 0 ? (
        <p className="muted text-sm">No matches yet. If another maker&apos;s thread is the same color, add its number: the register&apos;s Find a color shows it beside this one.</p>
      ) : (
        <ul className="divide-y divide-line">
          {same.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="flex items-center gap-2">
                <ColorDot hex={s.colorHex} />
                <Link href={`/parts/${s.id}`} className="link">
                  {s.label}
                </Link>
                <span className="muted text-sm">{s.qtyOnHand > 0 ? `${s.qtyOnHand} on the shelf` : "none on the shelf"}</span>
              </span>
              <ActionButton action={unlinkSameColor.bind(null, partId, s.id)} className="btn btn-sm">
                Take off
              </ActionButton>
            </li>
          ))}
        </ul>
      )}
      <ActionForm action={linkSameColor.bind(null, partId)} reset className="mt-3 flex flex-wrap items-end gap-2">
        <div className="field min-w-48 flex-1">
          <label htmlFor="same-other" className="label">
            The other item&apos;s number
          </label>
          <input id="same-other" name="other" className="input mono" placeholder="MAD-1147" autoComplete="off" required />
        </div>
        <Submit className="btn">Mark as the same color</Submit>
      </ActionForm>
    </Section>
  );
}
