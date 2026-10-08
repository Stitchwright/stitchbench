-- CreateTable
CREATE TABLE "Lender" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "applyUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Lender_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancedSale" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "lenderId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "approval" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "paidById" TEXT,
    "voidedAt" TIMESTAMP(3),

    CONSTRAINT "FinancedSale_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Lender_shopId_idx" ON "Lender"("shopId");

-- CreateIndex
CREATE INDEX "FinancedSale_shopId_paidAt_idx" ON "FinancedSale"("shopId", "paidAt");

-- CreateIndex
CREATE INDEX "FinancedSale_saleId_idx" ON "FinancedSale"("saleId");

-- CreateIndex
CREATE INDEX "FinancedSale_lenderId_idx" ON "FinancedSale"("lenderId");

-- AddForeignKey
ALTER TABLE "Lender" ADD CONSTRAINT "Lender_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancedSale" ADD CONSTRAINT "FinancedSale_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancedSale" ADD CONSTRAINT "FinancedSale_lenderId_fkey" FOREIGN KEY ("lenderId") REFERENCES "Lender"("id") ON DELETE CASCADE ON UPDATE CASCADE;

