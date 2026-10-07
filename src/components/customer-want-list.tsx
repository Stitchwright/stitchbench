// A customer's want list on her page (shop-features-round-2-design.md 1.4): the lines ("Here now" first) and "Add to her
// want list".
import { wantsFor } from "@/lib/want-lists";
import { WantAddForm } from "@/components/want-add-form";
import { WantLines } from "@/components/want-lines";
import { Section } from "@/components/ui";

export async function CustomerWantList({ shopId, customerId, tz }: { shopId: string; customerId: string; tz: string }) {
  const rows = await wantsFor(shopId, { customerId });
  return (
    <Section title="Want list">
      {rows.length ? <WantLines rows={rows} tz={tz} showCustomer={false} /> : <p className="muted mb-2 text-base">Nothing on her want list. Add what she&apos;d like to hear about when it comes in.</p>}
      <details className="mt-2">
        <summary className="link cursor-pointer text-base">Add to her want list</summary>
        <div className="mt-2">
          <WantAddForm customerId={customerId} />
        </div>
      </details>
    </Section>
  );
}
