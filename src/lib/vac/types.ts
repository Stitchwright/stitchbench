// Vac Shop types shared by the register (client) and the unit hooks (server). Pure.
export type TradeInInput = {
  brand: string;
  model: string;
  serial: string | null;
  machineType: string | null;
  condition: "NEW" | "OPEN_BOX" | "REFURB" | "USED";
  bagged: "Bagged" | "Bagless" | null;
  bagType: string | null;
};

/** A unit or trade-in line the Vac Shop tools add to the register's cart. */
export type VacCartLine = {
  description: string;
  qty: number;
  unitPriceCents: number;
  taxable: boolean;
  unit: null;
  stockUnitId?: string;
  tradeIn?: TradeInInput;
};
