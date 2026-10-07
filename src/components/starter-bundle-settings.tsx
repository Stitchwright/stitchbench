// Settings → Selling → Starter bundles (shop-features-round-2-design.md 6.1): what goes with a new machine of a kind,
// added to its sale in one tap at the register.
import { listBundles } from "@/lib/starter-bundles";
import { BUILT_IN_KINDS } from "@/lib/equipment";
import { deleteStarterBundle, saveStarterBundle } from "@/actions/starter-bundles";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { Section } from "@/components/ui";

const KINDS = BUILT_IN_KINDS.filter((k) => k.key === "sewing" || k.key === "vacuum" || k.sellFree).map((k) => ({ key: k.key, label: k.label }));

function Fields({ id, kind, name, items }: { id: string; kind?: string; name?: string; items?: string }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="field">
        <label className="label" htmlFor={`sb-kind-${id}`}>
          Goes with a new
        </label>
        <select id={`sb-kind-${id}`} name="kind" defaultValue={kind ?? "3d-printer"} className="select">
          {KINDS.map((k) => (
            <option key={k.key} value={k.key}>
              {k.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="label" htmlFor={`sb-name-${id}`}>
          Name
        </label>
        <input id={`sb-name-${id}`} name="name" defaultValue={name ?? ""} className="input" placeholder="Bambu starter" required />
      </div>
      <div className="field sm:col-span-2">
        <label className="label" htmlFor={`sb-items-${id}`}>
          Items, one a line: the item&apos;s number and how many
        </label>
        <textarea id={`sb-items-${id}`} name="items" defaultValue={items ?? ""} rows={3} className="input mono" placeholder={"PLA-BLK, 2\nGLUE-1"} required />
      </div>
    </div>
  );
}

export async function StarterBundleSettings({ shopId }: { shopId: string }) {
  const bundles = await listBundles(shopId);
  return (
    <Section title="Starter bundles" id="bundles">
      <p className="muted mb-3 text-sm">What you put with a new machine of a kind: at the register, a machine of that kind on the sale shows &quot;Add the starter bundle&quot;.</p>
      {bundles.map((b) => (
        <details key={b.id} className="border-b border-line py-2">
          <summary className="cursor-pointer text-base">
            {b.name} <span className="muted text-sm">· {b.kindLabel} · {b.lines.map((l) => `${l.qty} ${l.description}`).join(", ")}</span>
          </summary>
          <ActionForm action={saveStarterBundle.bind(null, b.id)} success="Saved" className="mt-2 space-y-3">
            <Fields id={b.id} kind={b.kind} name={b.name} items={b.lines.map((l) => `${l.partNumber}, ${l.qty}`).join("\n")} />
            <div className="flex flex-wrap gap-2">
              <Submit className="btn">Save</Submit>
              <ActionButton action={deleteStarterBundle.bind(null, b.id)} className="btn" confirm="Tap again to remove the bundle">
                Remove
              </ActionButton>
            </div>
          </ActionForm>
        </details>
      ))}
      <details className="pt-2" open={bundles.length === 0}>
        <summary className="link cursor-pointer text-sm">Add a starter bundle</summary>
        <ActionForm action={saveStarterBundle.bind(null, null)} reset success="Added" className="mt-2 space-y-3">
          <Fields id="new" />
          <Submit>Add the bundle</Submit>
        </ActionForm>
      </details>
    </Section>
  );
}
