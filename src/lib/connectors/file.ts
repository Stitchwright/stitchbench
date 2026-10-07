import "server-only";
// The generic file connector (package F6): works with any wholesaler, no permission needed. Catalog: the wholesaler's
// spreadsheet read through the supplier's saved column map. Orders: written in the supplier's own column layout (its
// cart-upload CSV) for the shop to upload on the wholesaler's site. Nothing is logged in to; no password is kept.
import { fileNameFor, orderRows, readCatalogRows } from "./layout";
import type { ColumnMap, OrderLayout, WholesalerConnector } from "./types";

/** A file-channel adapter: the generic one, or a wholesaler's with its own starting columns. */
export function makeFileConnector(o: { id: string; label: string; blurb: string; placeholder?: boolean; defaultMap?: ColumnMap; defaultLayout?: OrderLayout }): WholesalerConnector {
  return {
    id: o.id,
    label: o.label,
    channel: "file",
    blurb: o.blurb,
    placeholder: o.placeholder,
    defaultMap: o.defaultMap,
    readCatalog: (table, map) => readCatalogRows(table, Object.keys(map).length ? map : (o.defaultMap ?? {})),
    exportOrder: (ctx, order) => ({ filename: fileNameFor(order), rows: orderRows(order, ctx.supplier.orderLayout ?? o.defaultLayout ?? null, ctx.supplier.accountNumber) }),
    async placeOrder(ctx, order) {
      return { via: "file", note: `Order #${order.number} is marked sent. Download the spreadsheet below and upload it on ${ctx.supplier.name}'s site (their cart upload or quick order).` };
    },
  };
}

export const fileConnector = makeFileConnector({
  id: "file",
  label: "Spreadsheet (upload on their site)",
  blurb: "Reads the wholesaler's catalog spreadsheet and writes your order as a spreadsheet in the columns their site wants. Works with any wholesaler.",
});
