-- AlterTable
ALTER TABLE "ConsignSale" ADD COLUMN     "shopKeepsCents" INTEGER;

-- AlterTable
ALTER TABLE "HubState" ADD COLUMN     "partnerLockUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "shopId" TEXT;

-- AlterTable
ALTER TABLE "MarketOrder" ADD COLUMN     "shopId" TEXT;

-- AlterTable
ALTER TABLE "PartnerOutbox" ADD COLUMN     "deadAt" TIMESTAMP(3),
ADD COLUMN     "nextTryAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "RepairJob" ADD COLUMN     "repairPaidCents" INTEGER;

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "timeZone" TEXT NOT NULL DEFAULT 'America/New_York';

-- CreateTable
CREATE TABLE "PartnerFailure" (
    "shopId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "error" TEXT NOT NULL,
    "tries" INTEGER NOT NULL DEFAULT 1,
    "skipped" BOOLEAN NOT NULL DEFAULT false,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartnerFailure_pkey" PRIMARY KEY ("shopId","key")
);

-- CreateIndex
CREATE INDEX "MarketOrder_shopId_idx" ON "MarketOrder"("shopId");


-- An install with one company: its marketplace listings and orders are that company's.
UPDATE "Listing" SET "shopId" = (SELECT id FROM "Shop" LIMIT 1) WHERE mine AND "shopId" IS NULL AND (SELECT count(*) FROM "Shop") = 1;
UPDATE "MarketOrder" SET "shopId" = (SELECT id FROM "Shop" LIMIT 1) WHERE "shopId" IS NULL AND (SELECT count(*) FROM "Shop") = 1;
