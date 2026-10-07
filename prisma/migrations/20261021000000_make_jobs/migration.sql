-- AlterTable
ALTER TABLE "EstimateLink" ADD COLUMN     "makeJobId" TEXT;

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "makeNeverCut" TEXT NOT NULL DEFAULT 'PVC, vinyl',
ADD COLUMN     "makeRateCents" INTEGER NOT NULL DEFAULT 2000,
ADD COLUMN     "makeSetupCents" INTEGER NOT NULL DEFAULT 500,
ADD COLUMN     "nextMakeJobNumber" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "MakeJob" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "customerId" TEXT,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'PRINT',
    "status" TEXT NOT NULL DEFAULT 'QUOTED',
    "title" TEXT NOT NULL,
    "fileName" TEXT,
    "fileMime" TEXT,
    "fileData" BYTEA,
    "fileDeleteAfter" TIMESTAMP(3),
    "machineMinutes" INTEGER NOT NULL DEFAULT 0,
    "materialPartId" TEXT,
    "materialName" TEXT,
    "materialQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "materialUnit" TEXT,
    "materialCents" INTEGER NOT NULL DEFAULT 0,
    "setupCents" INTEGER NOT NULL DEFAULT 0,
    "rateCents" INTEGER NOT NULL DEFAULT 0,
    "quoteCents" INTEGER NOT NULL DEFAULT 0,
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "estimateLinkId" TEXT,
    "dueAt" TIMESTAMP(3),
    "turnedDownWhy" TEXT,
    "saleId" TEXT,
    "note" TEXT,
    "approvedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "collectedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MakeJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MakeJob_shopId_status_idx" ON "MakeJob"("shopId", "status");

-- CreateIndex
CREATE INDEX "MakeJob_shopId_customerId_idx" ON "MakeJob"("shopId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "MakeJob_shopId_number_key" ON "MakeJob"("shopId", "number");

-- AddForeignKey
ALTER TABLE "MakeJob" ADD CONSTRAINT "MakeJob_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MakeJob" ADD CONSTRAINT "MakeJob_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

