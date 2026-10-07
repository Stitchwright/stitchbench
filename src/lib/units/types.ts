// Machines-for-sale types shared by the register (client) and the unit hooks (server). Pure.
export type TradeInInput = {
  /** The equipment kind's key (sewing, vacuum, a shop kind...); absent from older registers, whose trade-ins were vacuums. */
  kind?: string | null;
  brand: string;
  model: string;
  serial: string | null;
  machineType: string | null;
  condition: "NEW" | "OPEN_BOX" | "REFURB" | "USED";
  /** A vacuum's answers; null for any other kind. */
  bagged: "Bagged" | "Bagless" | null;
  bagType: string | null;
};

/** A plan sold at the register for a machine: on this sale (stockUnitId) or one of the customer's (machineId). */
export type PlanCart = { planId: string; stockUnitId?: string | null; machineId?: string | null };

/** A unit, trade-in or plan line the machines-for-sale tools add to the register's cart. */
export type UnitCartLine = {
  description: string;
  qty: number;
  unitPriceCents: number;
  taxable: boolean;
  unit: null;
  stockUnitId?: string;
  tradeIn?: TradeInInput;
  servicePlan?: PlanCart;
};
