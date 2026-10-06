-- AlterTable
ALTER TABLE "SaleLine" ADD COLUMN     "kind" TEXT;


-- Fill older lines the way saleLineKind works out a category (src/lib/sale-kind.ts)
UPDATE "SaleLine" l SET "kind" = CASE
  WHEN l."giftCardId" IS NOT NULL THEN 'GIFT_CARD'
  WHEN l."tradeInUnitId" IS NOT NULL THEN 'TRADE_IN'
  WHEN l."stockUnitId" IS NOT NULL THEN 'UNIT'
  WHEN l."repairJobId" IS NOT NULL THEN 'REPAIR'
  WHEN l."enrollmentId" IS NOT NULL THEN 'CLASS'
  WHEN l."appointmentId" IS NOT NULL THEN 'APPOINTMENT'
  ELSE COALESCE((SELECT p."kind"::text FROM "Part" p WHERE p."id" = l."partId"), 'MISC')
END;
