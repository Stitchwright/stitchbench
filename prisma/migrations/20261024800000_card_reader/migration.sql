-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "cardReaderOn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "terminalLocationId" TEXT;

-- CreateTable
CREATE TABLE "CardReader" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "readerId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "deviceType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CardReader_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardPayment" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "readerId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "last4" TEXT,
    "brand" TEXT,
    "saleId" TEXT,
    "refundedCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CardPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CardReader_shopId_readerId_key" ON "CardReader"("shopId", "readerId");

-- CreateIndex
CREATE UNIQUE INDEX "CardPayment_intentId_key" ON "CardPayment"("intentId");

-- CreateIndex
CREATE INDEX "CardPayment_shopId_saleId_idx" ON "CardPayment"("shopId", "saleId");

-- CreateIndex
CREATE INDEX "CardPayment_shopId_status_idx" ON "CardPayment"("shopId", "status");

-- AddForeignKey
ALTER TABLE "CardReader" ADD CONSTRAINT "CardReader_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardPayment" ADD CONSTRAINT "CardPayment_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

