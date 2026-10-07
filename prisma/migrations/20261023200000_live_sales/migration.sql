-- CreateTable
CREATE TABLE "LiveSale" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "holdHours" INTEGER NOT NULL DEFAULT 48,
    "picks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "LiveSale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiveClaim" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "liveSaleId" TEXT NOT NULL,
    "customerId" TEXT,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "partId" TEXT,
    "description" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "unit" TEXT,
    "priceCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'HELD',
    "webOrderId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "letGoAt" TIMESTAMP(3),

    CONSTRAINT "LiveClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LiveSale_shopId_startsAt_idx" ON "LiveSale"("shopId", "startsAt");

-- CreateIndex
CREATE INDEX "LiveClaim_liveSaleId_status_idx" ON "LiveClaim"("liveSaleId", "status");

-- CreateIndex
CREATE INDEX "LiveClaim_shopId_status_partId_idx" ON "LiveClaim"("shopId", "status", "partId");

-- AddForeignKey
ALTER TABLE "LiveSale" ADD CONSTRAINT "LiveSale_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveClaim" ADD CONSTRAINT "LiveClaim_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveClaim" ADD CONSTRAINT "LiveClaim_liveSaleId_fkey" FOREIGN KEY ("liveSaleId") REFERENCES "LiveSale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

