-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "nextCoopNumber" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "CoopClaim" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "maker" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'COOP',
    "program" TEXT,
    "adWhere" TEXT,
    "placedOn" TEXT,
    "spentCents" INTEGER NOT NULL DEFAULT 0,
    "claimCents" INTEGER NOT NULL DEFAULT 0,
    "deadline" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "filedAt" TIMESTAMP(3),
    "receivedCents" INTEGER NOT NULL DEFAULT 0,
    "receivedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoopClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoopProof" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoopProof_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CoopClaim_shopId_status_deadline_idx" ON "CoopClaim"("shopId", "status", "deadline");

-- CreateIndex
CREATE UNIQUE INDEX "CoopClaim_shopId_number_key" ON "CoopClaim"("shopId", "number");

-- CreateIndex
CREATE INDEX "CoopProof_claimId_idx" ON "CoopProof"("claimId");

-- AddForeignKey
ALTER TABLE "CoopClaim" ADD CONSTRAINT "CoopClaim_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoopProof" ADD CONSTRAINT "CoopProof_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoopProof" ADD CONSTRAINT "CoopProof_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "CoopClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

