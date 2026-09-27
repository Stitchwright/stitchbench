-- Data only, no schema change.

-- A ticket moved back to an open status kept the return date, warranty and ready date of the earlier close, which put
-- it in the wrong month of the sales log, printed "Returned" on its invoice and kept techs off its bill. Open tickets
-- have none of those now (a ready one keeps the day it was ready).
UPDATE "Ticket" SET "closedAt" = NULL, "warrantyUntil" = NULL
WHERE "status" NOT IN ('COLLECTED', 'ABANDONED', 'RETURNED_UNREPAIRED')
  AND ("closedAt" IS NOT NULL OR "warrantyUntil" IS NOT NULL);

UPDATE "Ticket" SET "readyAt" = NULL
WHERE "status" IN ('AT_SHOP_AWAITING_PICKUP', 'IN_TRUCK', 'ON_BENCH', 'WAITING_CUSTOMER_OK', 'WAITING_PARTS')
  AND "readyAt" IS NOT NULL;

-- A trade account's commission typed as "10%" was stored as NaN, which paid no commission and showed "NaN" in the
-- form. Blank is what it amounted to.
UPDATE "Customer" SET "commissionPct" = NULL WHERE "commissionPct" = 'NaN'::double precision;
