-- CreateTable
CREATE TABLE "SuppliesCare" (
    "machineId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "calledAt" TIMESTAMP(3),
    "calledBy" TEXT,
    "callNote" TEXT,
    "snoozeUntil" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SuppliesCare_pkey" PRIMARY KEY ("machineId")
);

-- CreateIndex
CREATE INDEX "SuppliesCare_shopId_idx" ON "SuppliesCare"("shopId");

-- AddForeignKey
ALTER TABLE "SuppliesCare" ADD CONSTRAINT "SuppliesCare_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuppliesCare" ADD CONSTRAINT "SuppliesCare_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

