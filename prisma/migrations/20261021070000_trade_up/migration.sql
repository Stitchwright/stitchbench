-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "tradeInLessPct" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "tradeUpDays" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "TradeUpOffer" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "customerId" TEXT,
    "ticketId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "until" TEXT NOT NULL,
    "usedLineId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradeUpOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TradeUpOffer_usedLineId_idx" ON "TradeUpOffer"("usedLineId");

-- CreateIndex
CREATE UNIQUE INDEX "TradeUpOffer_shopId_ticketId_key" ON "TradeUpOffer"("shopId", "ticketId");

-- AddForeignKey
ALTER TABLE "TradeUpOffer" ADD CONSTRAINT "TradeUpOffer_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

