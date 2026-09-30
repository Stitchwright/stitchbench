-- AlterTable: a trade account's commission % is kept on the ticket when it closes, so editing the account (or switching
-- it to retail) no longer changes the commission owed on tickets already closed.
ALTER TABLE "Ticket" ADD COLUMN     "tradeCommissionPct" DOUBLE PRECISION;

-- Tickets closed before this: today's percentage is the best record there is, kept from now on.
UPDATE "Ticket" t SET "tradeCommissionPct" = COALESCE(c."commissionPct", 0)
FROM "Customer" c
WHERE t."viaAccountId" = c."id"
  AND t."closedAt" IS NOT NULL
  AND t."status" IN ('COLLECTED', 'ABANDONED', 'RETURNED_UNREPAIRED');
