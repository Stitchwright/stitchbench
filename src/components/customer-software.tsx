// "Software" on a customer's page and a machine's (shop-features-round-2-design.md 2.5): their licences, codes masked
// (one tap shows one). Nothing when they have none.
import { licensesOfCustomer, licensesOfMachine } from "@/lib/software";
import { LicenseList } from "@/components/software-licenses";
import { Section } from "@/components/ui";

export async function CustomerSoftware({ shopId, customerId, admin }: { shopId: string; customerId: string; admin: boolean }) {
  const rows = await licensesOfCustomer(shopId, customerId);
  if (!rows.length) return null;
  return (
    <Section title="Software">
      <LicenseList rows={rows} admin={admin} showCustomer={false} empty="" />
    </Section>
  );
}

export async function MachineSoftware({ shopId, machineId, admin }: { shopId: string; machineId: string; admin: boolean }) {
  const rows = await licensesOfMachine(shopId, machineId);
  if (!rows.length) return null;
  return (
    <Section title="Software">
      <LicenseList rows={rows} admin={admin} empty="" />
    </Section>
  );
}
