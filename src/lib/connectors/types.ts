// The wholesaler connector framework (fabric-smarts-design.md section 5a, package F6). One small adapter per wholesaler
// answers the same five things, each optional: catalog, prices, stock, place an order, order status. What an adapter
// can't do falls back to the next channel down (files, then email, then paper), so the rest of the program never knows
// which wholesaler it is talking to. Pure types: no database here. Never a wholesaler's password: nothing in this
// framework has a place to keep one (the shop's own account NUMBER with the wholesaler is the only identifier kept).
import type { OrderView } from "@/lib/fabric-orders";

export type Channel = "file" | "email" | "api" | "edi";

/** The catalog fields a spreadsheet column can fill. */
export const CATALOG_FIELDS = [
  { key: "itemNumber", label: "Maker's item number", required: true, hints: ["item number", "item #", "item no", "item no.", "item", "sku", "style", "style number", "style #", "product code", "mfr item", "mfr #", "part number", "part #"] },
  { key: "description", label: "Description", hints: ["description", "item description", "product name", "name", "title", "color", "colorway"] },
  { key: "costPerYard", label: "Your cost a yard", hints: ["cost", "wholesale", "wholesale price", "wholesale cost", "net price", "net", "your price", "price per yard", "cost per yard", "cost/yd"] },
  { key: "pricePerYard", label: "Retail price a yard", hints: ["retail", "retail price", "msrp", "srp", "list price", "suggested retail"] },
  { key: "collection", label: "Collection", hints: ["collection", "line", "series", "group"] },
  { key: "designer", label: "Designer", hints: ["designer", "artist"] },
  { key: "brand", label: "Maker (brand)", hints: ["maker", "brand", "manufacturer", "vendor", "mfr"] },
  { key: "boltYards", label: "Yards on a full bolt", hints: ["bolt yards", "yards per bolt", "bolt size", "bolt length", "yds/bolt"] },
] as const;
export type CatalogField = (typeof CATALOG_FIELDS)[number]["key"];

/** Catalog field -> the spreadsheet's column heading (kept by heading, so a re-ordered sheet still reads right). */
export type ColumnMap = Partial<Record<CatalogField, string>>;

export type CatalogRow = {
  /** The sheet row (1 = the heading row), for messages. */
  line: number;
  itemNumber: string;
  description?: string;
  costTenThou?: number;
  costCents?: number;
  priceCents?: number;
  collection?: string;
  designer?: string;
  brand?: string;
  boltYards?: number;
};

export type CatalogRead = { rows: CatalogRow[]; problems: string[]; missing: CatalogField[] };

/** What goes in a column of the order spreadsheet. */
export const ORDER_FIELDS = [
  { key: "itemNumber", label: "Maker's item number" },
  { key: "description", label: "Description" },
  { key: "quantity", label: "Amount in the line's own unit (bolts or yards)" },
  { key: "unit", label: "Unit (bolt or yd)" },
  { key: "yards", label: "Yards" },
  { key: "bolts", label: "Bolts (yards over the bolt length)" },
  { key: "costPerYard", label: "Cost a yard" },
  { key: "lineTotal", label: "Line total" },
  { key: "poNumber", label: "Your order number" },
  { key: "account", label: "Your account number" },
  { key: "note", label: "The order's note" },
  { key: "text", label: "Fixed text (same on every line)" },
] as const;
export type OrderField = (typeof ORDER_FIELDS)[number]["key"];
export type OrderColumn = { header: string; field: OrderField; text?: string };
export type OrderLayout = OrderColumn[];

/** A supplier as a connector sees it. */
export type ConnectorSupplier = {
  id: string;
  name: string;
  orderEmail: string | null;
  accountNumber: string | null;
  catalogMap: ColumnMap | null;
  orderLayout: OrderLayout | null;
};

export type ConnectorContext = { shopId: string; supplier: ConnectorSupplier };

/**
 * How an order left: "smtp" sent from the shop's own mail account; "mailto" the shop's mail program will do it (the
 * page offers the link); "file" the cart-upload spreadsheet is ready to upload on the wholesaler's site; "none" the
 * program passed it on to nobody (print it or phone it).
 */
export type OrderVia = "smtp" | "mailto" | "file" | "none";
export type OrderOutcome = { via: OrderVia; note: string };

export type OrderFile = { filename: string; rows: unknown[][] };

export interface WholesalerConnector {
  id: string;
  label: string;
  channel: Channel;
  blurb: string;
  /** A stub: the wholesaler hasn't shared its layout yet, so the columns here are guesses to be replaced. */
  placeholder?: boolean;
  /** Catalog: read a spreadsheet's rows through the supplier's column map. */
  readCatalog?(table: string[][], map: ColumnMap): CatalogRead;
  /** The map a supplier on this connector starts with (a placeholder for a stub). */
  defaultMap?: ColumnMap;
  /** Prices and stock from the wholesaler, by item number (API partners only: not the file or email connectors). */
  prices?(ctx: ConnectorContext, itemNumbers: string[]): Promise<Map<string, number>>;
  stock?(ctx: ConnectorContext, itemNumbers: string[]): Promise<Map<string, number>>;
  /** The order as the wholesaler's cart-upload spreadsheet. */
  exportOrder?(ctx: ConnectorContext, order: OrderView): OrderFile;
  /** Sends the order the best way this connector can; throws UserError (with plain words) when it can't and nothing went. */
  placeOrder?(ctx: ConnectorContext, order: OrderView): Promise<OrderOutcome>;
  /** Where a placed order stands (API and EDI only). */
  orderStatus?(ctx: ConnectorContext, order: OrderView): Promise<{ status: string; detail?: string }>;
}
