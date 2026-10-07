-- AlterTable
ALTER TABLE "Enrollment" ADD COLUMN     "creditUnitId" TEXT;

-- AlterTable
ALTER TABLE "SaleLine" ADD COLUMN     "machinePlanId" TEXT;

-- AlterTable
ALTER TABLE "StockUnit" ADD COLUMN     "bundle" TEXT,
ADD COLUMN     "classCredits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "includedPlanId" TEXT;

-- AlterTable
ALTER TABLE "TicketLine" ADD COLUMN     "coveredCents" INTEGER,
ADD COLUMN     "coveredPlanId" TEXT;

-- CreateTable
CREATE TABLE "MakerWarranty" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "brandKey" TEXT NOT NULL,
    "partsYears" DOUBLE PRECISION,
    "laborYears" DOUBLE PRECISION,
    "electronicsYears" DOUBLE PRECISION,
    "registerUrl" TEXT,
    "note" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MakerWarranty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServicePlan" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "visits" INTEGER,
    "months" INTEGER NOT NULL,
    "priceCents" INTEGER NOT NULL DEFAULT 0,
    "taxable" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServicePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MachinePlan" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "planId" TEXT,
    "name" TEXT NOT NULL,
    "visits" INTEGER,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "saleLineId" TEXT,
    "stockUnitId" TEXT,
    "voidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MachinePlan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MakerWarranty_shopId_brandKey_key" ON "MakerWarranty"("shopId", "brandKey");

-- CreateIndex
CREATE INDEX "ServicePlan_shopId_idx" ON "ServicePlan"("shopId");

-- CreateIndex
CREATE INDEX "MachinePlan_shopId_machineId_idx" ON "MachinePlan"("shopId", "machineId");

-- CreateIndex
CREATE INDEX "MachinePlan_saleLineId_idx" ON "MachinePlan"("saleLineId");

-- CreateIndex
CREATE INDEX "TicketLine_coveredPlanId_idx" ON "TicketLine"("coveredPlanId");

-- AddForeignKey
ALTER TABLE "MakerWarranty" ADD CONSTRAINT "MakerWarranty_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServicePlan" ADD CONSTRAINT "ServicePlan_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachinePlan" ADD CONSTRAINT "MachinePlan_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachinePlan" ADD CONSTRAINT "MachinePlan_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

