import "server-only";
// The connector registry (package F6): one entry per adapter. A supplier names its connector by id; an unknown or
// retired id falls back to email, the channel that always works. New adapters (API and EDI partners) are added here.
import { emailConnector } from "./email";
import { fileConnector } from "./file";
import { notionsMarketingConnector } from "./notions-marketing";
import type { WholesalerConnector } from "./types";

const CONNECTORS: WholesalerConnector[] = [emailConnector, fileConnector, notionsMarketingConnector];

export const connectorList = (): WholesalerConnector[] => CONNECTORS;
export const connectorFor = (id: string | null | undefined): WholesalerConnector => CONNECTORS.find((c) => c.id === id) ?? emailConnector;
export const isConnectorId = (id: string): boolean => CONNECTORS.some((c) => c.id === id);
/** The adapter that reads a supplier's catalog spreadsheet: the supplier's own if it can, else the generic file connector. */
export const catalogConnectorFor = (id: string | null | undefined): WholesalerConnector => {
  const c = connectorFor(id);
  return c.readCatalog ? c : fileConnector;
};
