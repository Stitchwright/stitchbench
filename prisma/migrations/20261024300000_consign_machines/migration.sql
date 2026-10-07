-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "consignDefaultPct" DOUBLE PRECISION NOT NULL DEFAULT 25;

-- AlterTable
ALTER TABLE "StockUnit" ADD COLUMN     "consignPct" DOUBLE PRECISION,
ADD COLUMN     "consignUntil" TEXT,
ADD COLUMN     "consignorId" TEXT;

-- CreateTable
CREATE TABLE "ConsignPayout" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "saleLineId" TEXT NOT NULL,
    "soldCents" INTEGER NOT NULL,
    "pct" DOUBLE PRECISION NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "method" TEXT,
    "note" TEXT,
    "giftCardId" TEXT,
    "paidById" TEXT,
    "voidedAt" TIMESTAMP(3),

    CONSTRAINT "ConsignPayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConsignPayout_shopId_customerId_idx" ON "ConsignPayout"("shopId", "customerId");

-- CreateIndex
CREATE INDEX "ConsignPayout_shopId_paidAt_idx" ON "ConsignPayout"("shopId", "paidAt");

-- CreateIndex
CREATE INDEX "ConsignPayout_saleLineId_idx" ON "ConsignPayout"("saleLineId");

-- AddForeignKey
ALTER TABLE "ConsignPayout" ADD CONSTRAINT "ConsignPayout_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

