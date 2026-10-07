// Minimum advertised prices (shop-features-round-2-design.md 9.3). Pure: the online shop, the checks and the pages share it.

/** True when a price would advertise below the maker's minimum. */
export const belowMap = (priceCents: number | null | undefined, mapCents: number | null | undefined) => priceCents != null && mapCents != null && mapCents > 0 && priceCents < mapCents;
