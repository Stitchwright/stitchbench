// Fit groups (shop-features-round-2-design.md 2.4): a name the shop gives once ("Brother 7 mm low shank", "Cricut Maker
// 3", "Bambu P1 hot end") and its models; an item ticked into a group fits every model in it.
import { requireUser } from "@/lib/session";
import { fitGroupsFor } from "@/lib/fits";
import { deleteFitGroup, saveFitGroup } from "@/actions/fits";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { Empty, PageHeader } from "@/components/ui";

function GroupFields({ id, name, models }: { id: string; name?: string; models?: string[] }) {
  return (
    <>
      <div className="field">
        <label className="label" htmlFor={`fg-name-${id}`}>
          Name
        </label>
        <input id={`fg-name-${id}`} name="name" defaultValue={name ?? ""} className="input" placeholder="Brother 7 mm low shank" required />
      </div>
      <div className="field">
        <label className="label" htmlFor={`fg-models-${id}`}>
          Models, one a line: brand, model
        </label>
        <textarea id={`fg-models-${id}`} name="models" defaultValue={(models ?? []).join("\n")} rows={5} className="input" placeholder={"Brother, PE800\nBrother, SE600\nBaby Lock, Altair"} required />
      </div>
    </>
  );
}

export default async function FitGroupsPage() {
  const user = await requireUser();
  const groups = await fitGroupsFor(user.shopId);
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader back={{ href: "/parts", label: "Parts" }} title="Fit groups" sub="Name a set of machines once, then tick the group on each foot, bobbin, blade or die that fits them all." />
      <section className="card card-pad space-y-3">
        <h2 className="h2">Make a group</h2>
        <ActionForm action={saveFitGroup.bind(null, null)} reset success="Added" className="space-y-3">
          <GroupFields id="new" />
          <Submit>Add the group</Submit>
        </ActionForm>
      </section>
      {groups.length === 0 ? (
        <Empty>No fit groups yet. Make one above, then tick it on the items that fit.</Empty>
      ) : (
        groups.map((g) => (
          <section key={g.id} className="card card-pad space-y-3">
            <h2 className="h2">{g.name}</h2>
            <ActionForm action={saveFitGroup.bind(null, g.id)} success="Saved" className="space-y-3">
              <GroupFields id={g.id} name={g.name} models={g.models} />
              <div className="flex flex-wrap gap-2">
                <Submit>Save</Submit>
                <ActionButton action={deleteFitGroup.bind(null, g.id)} className="btn" confirm="Tap again: the items keep their own models">
                  Remove the group
                </ActionButton>
              </div>
            </ActionForm>
          </section>
        ))
      )}
    </div>
  );
}
