import "server-only";
// Notions Marketing (package F6, stub). Their wholesale site takes a CSV import and a quick order by SKU, but they haven't
// shared the layout yet (the outreach draft asks for it). Until they do, this is the generic file connector with guessed
// columns, marked as a placeholder on the supplier's page; the shop can edit the columns itself, and once the real layout
// arrives only the two constants below change.
import { makeFileConnector } from "./file";
import type { ColumnMap, OrderLayout } from "./types";

/** PLACEHOLDER catalog headings: replace with Notions Marketing's real export once they share it. */
export const NOTIONS_MARKETING_MAP: ColumnMap = { itemNumber: "SKU", description: "Description", costPerYard: "Cost", pricePerYard: "MSRP" };

/** PLACEHOLDER cart-upload columns: replace with Notions Marketing's real import layout once they share it. */
export const NOTIONS_MARKETING_LAYOUT: OrderLayout = [
  { header: "SKU", field: "itemNumber" },
  { header: "Quantity", field: "quantity" },
  { header: "PO Number", field: "poNumber" },
];

export const notionsMarketingConnector = makeFileConnector({
  id: "notions-marketing",
  label: "Notions Marketing (layout to come)",
  blurb: "Uses the spreadsheet connector with placeholder columns until Notions Marketing shares its import layout.",
  placeholder: true,
  defaultMap: NOTIONS_MARKETING_MAP,
  defaultLayout: NOTIONS_MARKETING_LAYOUT,
});
