-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "priceGroupId" TEXT,
ADD COLUMN     "priceGroupUntil" TEXT;

-- AlterTable
ALTER TABLE "Part" ADD COLUMN     "membershipGroupId" TEXT,
ADD COLUMN     "membershipMonths" INTEGER;

-- AlterTable
ALTER TABLE "SaleLine" ADD COLUMN     "priceGroupId" TEXT,
ADD COLUMN     "priceNote" TEXT;

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "lifetimePctDefault" INTEGER NOT NULL DEFAULT 25;

-- AlterTable
ALTER TABLE "StockUnit" ADD COLUMN     "lifetimePctOff" INTEGER;

-- CreateTable
CREATE TABLE "PriceGroup" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pctOff" INTEGER NOT NULL DEFAULT 0,
    "useWholesale" BOOLEAN NOT NULL DEFAULT false,
    "kinds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "onSaleItems" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PriceGroup_shopId_idx" ON "PriceGroup"("shopId");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_priceGroupId_fkey" FOREIGN KEY ("priceGroupId") REFERENCES "PriceGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceGroup" ADD CONSTRAINT "PriceGroup_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

