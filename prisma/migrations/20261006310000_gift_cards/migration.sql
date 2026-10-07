-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PaymentMethod" ADD VALUE 'GIFT';
ALTER TYPE "PaymentMethod" ADD VALUE 'CREDIT';

-- AlterTable
ALTER TABLE "SaleLine" ADD COLUMN     "giftCardId" TEXT;

-- CreateTable
CREATE TABLE "GiftCard" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'gift',
    "customerId" TEXT,
    "balanceCents" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdById" TEXT,

    CONSTRAINT "GiftCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiftCardEntry" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "amountCents" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "saleId" TEXT,
    "saleLineId" TEXT,
    "paymentId" TEXT,
    "ticketId" TEXT,
    "userId" TEXT,
    "note" TEXT,

    CONSTRAINT "GiftCardEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GiftCard_shopId_customerId_idx" ON "GiftCard"("shopId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "GiftCard_shopId_number_key" ON "GiftCard"("shopId", "number");

-- CreateIndex
CREATE INDEX "GiftCardEntry_cardId_at_idx" ON "GiftCardEntry"("cardId", "at");

-- CreateIndex
CREATE INDEX "GiftCardEntry_shopId_at_idx" ON "GiftCardEntry"("shopId", "at");

-- CreateIndex
CREATE INDEX "GiftCardEntry_saleId_idx" ON "GiftCardEntry"("saleId");

-- CreateIndex
CREATE INDEX "GiftCardEntry_paymentId_idx" ON "GiftCardEntry"("paymentId");

-- AddForeignKey
ALTER TABLE "GiftCard" ADD CONSTRAINT "GiftCard_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftCard" ADD CONSTRAINT "GiftCard_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftCardEntry" ADD CONSTRAINT "GiftCardEntry_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "GiftCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A card never holds less than nothing, whatever the program does (later-round-1-design.md 2.2): the guarded update in
-- src/lib/gift-cards.ts postEntry is how a spend is refused politely; this is the backstop.
ALTER TABLE "GiftCard" ADD CONSTRAINT "GiftCard_balance_nonneg" CHECK ("balanceCents" >= 0);
