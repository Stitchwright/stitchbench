-- AlterTable
ALTER TABLE "Part" ADD COLUMN     "comingSoonOn" TEXT,
ADD COLUMN     "depositKept" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "SaleLine" ADD COLUMN     "specialOrderId" TEXT;

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "nextSpecialOrderNumber" INTEGER NOT NULL DEFAULT 1001,
ADD COLUMN     "specialOrderDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "specialOrderDepositCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "specialOrderDepositPct" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "specialOrderDepositRule" TEXT NOT NULL DEFAULT 'credit';

-- CreateTable
CREATE TABLE "SpecialOrder" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "customerId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'ORDER',
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "partId" TEXT,
    "description" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "unit" TEXT,
    "priceCents" INTEGER NOT NULL,
    "depositCents" INTEGER NOT NULL DEFAULT 0,
    "depositRule" TEXT NOT NULL DEFAULT 'credit',
    "expectedOn" TEXT,
    "poLineId" TEXT,
    "heldQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "hereAt" TIMESTAMP(3),
    "noticedAt" TIMESTAMP(3),
    "calledAt" TIMESTAMP(3),
    "saleId" TEXT,
    "prevStatus" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpecialOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SpecialOrder_shopId_status_idx" ON "SpecialOrder"("shopId", "status");

-- CreateIndex
CREATE INDEX "SpecialOrder_shopId_partId_idx" ON "SpecialOrder"("shopId", "partId");

-- CreateIndex
CREATE INDEX "SpecialOrder_customerId_idx" ON "SpecialOrder"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "SpecialOrder_shopId_number_key" ON "SpecialOrder"("shopId", "number");

-- AddForeignKey
ALTER TABLE "SpecialOrder" ADD CONSTRAINT "SpecialOrder_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpecialOrder" ADD CONSTRAINT "SpecialOrder_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

