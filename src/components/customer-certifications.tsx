// "Certified on" on a customer's page (shop-features-round-2-design.md 6.4): the machines she may use on her own (the
// longarm, the laser, the 3D printer...), each with its day, and for an owner or admin one tap to certify her after the
// safety class (or take it off). Nothing for a shop that certifies on nothing.
import { certificationsOf, equipmentChoices } from "@/lib/certifications";
import { certify, uncertify } from "@/actions/certifications";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { Section } from "@/components/ui";
import { fmtDate } from "@/lib/format";

export async function CustomerCertifications({ shopId, customerId, admin, tz }: { shopId: string; customerId: string; admin: boolean; tz: string }) {
  const [certs, choices] = await Promise.all([certificationsOf(shopId, customerId), equipmentChoices(shopId)]);
  if (!certs.length && !choices.length) return null;
  const left = choices.filter((c) => !certs.some((x) => x.equipment.toLowerCase() === c.toLowerCase()));
  return (
    <Section title="Certified on">
      {certs.length === 0 ? (
        <p className="muted text-sm">Not certified on any machine yet. After the safety class, certify her here: she can then book that machine by the hour.</p>
      ) : (
        <ul className="divide-y divide-line">
          {certs.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="text-base">
                <span className="pill tone-ready">{c.equipment}</span> <span className="muted text-sm">since {fmtDate(c.certifiedAt, tz)}</span>
              </span>
              {admin && (
                <ActionButton action={uncertify.bind(null, customerId, c.equipment)} className="btn btn-sm" confirm={`Tap again: no longer certified on the ${c.equipment}`}>
                  Take off
                </ActionButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {admin && left.length > 0 && (
        <ActionForm action={certify.bind(null, customerId)} className="mt-3 flex flex-wrap items-end gap-2">
          <div className="field">
            <label className="label" htmlFor={`cert-${customerId}`}>
              Passed the safety class on the
            </label>
            <select id={`cert-${customerId}`} name="equipment" className="select" defaultValue={left[0]}>
              {left.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <Submit className="btn">Certify</Submit>
        </ActionForm>
      )}
    </Section>
  );
}
