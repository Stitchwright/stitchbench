-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "houseAccountsOn" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "HouseAccount" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "limitCents" INTEGER NOT NULL DEFAULT 0,
    "termsDays" INTEGER NOT NULL DEFAULT 30,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HouseAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountEntry" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "method" TEXT,
    "note" TEXT,
    "saleId" TEXT,
    "ticketId" TEXT,
    "paymentId" TEXT,
    "byUserId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),

    CONSTRAINT "AccountEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HouseAccount_shopId_customerId_key" ON "HouseAccount"("shopId", "customerId");

-- CreateIndex
CREATE INDEX "AccountEntry_accountId_at_idx" ON "AccountEntry"("accountId", "at");

-- CreateIndex
CREATE INDEX "AccountEntry_shopId_at_idx" ON "AccountEntry"("shopId", "at");

-- CreateIndex
CREATE INDEX "AccountEntry_saleId_idx" ON "AccountEntry"("saleId");

-- AddForeignKey
ALTER TABLE "HouseAccount" ADD CONSTRAINT "HouseAccount_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountEntry" ADD CONSTRAINT "AccountEntry_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountEntry" ADD CONSTRAINT "AccountEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "HouseAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

