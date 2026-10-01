// A class seat or an appointment with money owed, as the register rings it up (scheduling-messaging-design.md 4.1). Pure.
export type BookingDue = {
  kind: "enrollment" | "appointment";
  id: string;
  description: string;
  dueCents: number;
  taxable: boolean;
  customerId: string | null;
  customerName: string;
  startsAt: Date;
};
