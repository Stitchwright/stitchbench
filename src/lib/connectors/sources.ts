// Catalog sources (shop-features-round-2-design.md 2.3, the CatalogSource interface in ./types). The spreadsheet upload
// is the one source today; a distributor's own feed or API is added here as one more entry once it is documented (its
// fetchCatalog maps the feed to CatalogRows; the key comes sealed from the shop's settings). Pure list: no database.
import type { CatalogSource } from "./types";

export const SPREADSHEET: CatalogSource = { id: "file", label: "A spreadsheet from the supplier (CSV or Excel)", kind: "file" };

/** Every source the import offers; feed sources join this list. */
export const CATALOG_SOURCES: CatalogSource[] = [SPREADSHEET];

export const catalogSourceFor = (id: string): CatalogSource | undefined => CATALOG_SOURCES.find((s) => s.id === id);
