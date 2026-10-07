-- AlterEnum
ALTER TYPE "MoveReason" ADD VALUE 'HELD';

-- AlterTable
ALTER TABLE "SaleLine" ADD COLUMN     "layawayId" TEXT;

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "layawayDays" INTEGER NOT NULL DEFAULT 90,
ADD COLUMN     "layawayDepositPct" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "layawayEvery" TEXT NOT NULL DEFAULT '2w',
ADD COLUMN     "layawayFeeCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "layawayFeePct" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "layawayRefund" TEXT NOT NULL DEFAULT 'credit',
ADD COLUMN     "layawayTerms" TEXT,
ADD COLUMN     "nextLayawayNumber" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "StockUnit" ADD COLUMN     "layawayId" TEXT;

-- CreateTable
CREATE TABLE "Layaway" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "customerId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueBy" TEXT NOT NULL,
    "every" TEXT NOT NULL DEFAULT '2w',
    "plan" JSONB NOT NULL DEFAULT '[]',
    "depositMinCents" INTEGER NOT NULL DEFAULT 0,
    "terms" TEXT NOT NULL,
    "note" TEXT,
    "saleId" TEXT,
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelFeeCents" INTEGER,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Layaway_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LayawayLine" (
    "id" TEXT NOT NULL,
    "layawayId" TEXT NOT NULL,
    "partId" TEXT,
    "stockUnitId" TEXT,
    "description" TEXT NOT NULL,
    "partNumber" TEXT,
    "unit" TEXT,
    "qty" DOUBLE PRECISION NOT NULL,
    "unitPriceCents" INTEGER NOT NULL,
    "discountCents" INTEGER NOT NULL DEFAULT 0,
    "taxable" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "LayawayLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Layaway_shopId_status_idx" ON "Layaway"("shopId", "status");

-- CreateIndex
CREATE INDEX "Layaway_customerId_idx" ON "Layaway"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Layaway_shopId_number_key" ON "Layaway"("shopId", "number");

-- CreateIndex
CREATE INDEX "LayawayLine_layawayId_idx" ON "LayawayLine"("layawayId");

-- CreateIndex
CREATE INDEX "SaleLine_layawayId_idx" ON "SaleLine"("layawayId");

-- AddForeignKey
ALTER TABLE "Layaway" ADD CONSTRAINT "Layaway_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Layaway" ADD CONSTRAINT "Layaway_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LayawayLine" ADD CONSTRAINT "LayawayLine_layawayId_fkey" FOREIGN KEY ("layawayId") REFERENCES "Layaway"("id") ON DELETE CASCADE ON UPDATE CASCADE;

