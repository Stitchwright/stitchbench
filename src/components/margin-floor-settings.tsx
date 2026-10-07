// Settings, Selling, "Margin floor" (shop-features-round-2-design.md 4.4): "Tell me when an item's margin falls under
// 40%", with a figure per kind folded under More choices. Empty: off. A server component; owners and admins save.
import { KIND_LABEL } from "@/lib/parts";
import { shopFloors } from "@/lib/repricing";
import { saveMarginFloors } from "@/actions/repricing";
import { ActionForm, Submit } from "@/components/action-form";
import { Section } from "@/components/ui";

const KINDS = Object.keys(KIND_LABEL).filter((k) => k !== "MACHINE");

export async function MarginFloorSettings({ shopId, admin }: { shopId: string; admin: boolean }) {
  const f = await shopFloors(shopId);
  return (
    <Section title="Margin floor" id="margin">
      <ActionForm action={saveMarginFloors} success="Saved" className="space-y-3">
        <fieldset disabled={!admin} className="space-y-3">
          <div className="field max-w-md">
            <label htmlFor="mf-all" className="label">
              Tell me when an item&apos;s margin falls under (%)
            </label>
            <input id="mf-all" name="floor_all" inputMode="numeric" defaultValue={f.all ?? ""} className="input num text-base" placeholder="40" />
            <span className="muted text-sm">Leave it empty to switch this off. Items under it show on Inventory with Raise prices ready.</span>
          </div>
          <details>
            <summary className="link cursor-pointer text-base">More choices: a different floor for a kind</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {KINDS.map((k) => (
                <div key={k} className="field">
                  <label htmlFor={`mf-${k}`} className="label">
                    {KIND_LABEL[k]} (%)
                  </label>
                  <input id={`mf-${k}`} name={`floor_${k}`} inputMode="numeric" defaultValue={f[k] ?? ""} className="input num text-base" placeholder={f.all != null ? String(f.all) : ""} />
                </div>
              ))}
            </div>
          </details>
          {admin && (
            <div className="flex justify-end">
              <Submit className="btn btn-primary min-h-11 text-base">Save the margin floor</Submit>
            </div>
          )}
        </fieldset>
      </ActionForm>
    </Section>
  );
}
