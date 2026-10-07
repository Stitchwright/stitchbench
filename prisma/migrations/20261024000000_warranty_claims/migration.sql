-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "nextClaimNumber" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "TicketLine" ADD COLUMN     "claimId" TEXT;

-- CreateTable
CREATE TABLE "WarrantyClaim" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "ticketId" TEXT,
    "machineId" TEXT,
    "maker" TEXT NOT NULL,
    "claimNumber" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "filedAt" TIMESTAMP(3),
    "partsCents" INTEGER NOT NULL DEFAULT 0,
    "laborCents" INTEGER NOT NULL DEFAULT 0,
    "expectedCents" INTEGER NOT NULL DEFAULT 0,
    "receivedCents" INTEGER NOT NULL DEFAULT 0,
    "receivedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WarrantyClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WarrantyClaim_shopId_status_idx" ON "WarrantyClaim"("shopId", "status");

-- CreateIndex
CREATE INDEX "WarrantyClaim_shopId_ticketId_idx" ON "WarrantyClaim"("shopId", "ticketId");

-- CreateIndex
CREATE UNIQUE INDEX "WarrantyClaim_shopId_number_key" ON "WarrantyClaim"("shopId", "number");

-- CreateIndex
CREATE INDEX "TicketLine_claimId_idx" ON "TicketLine"("claimId");

-- AddForeignKey
ALTER TABLE "WarrantyClaim" ADD CONSTRAINT "WarrantyClaim_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

