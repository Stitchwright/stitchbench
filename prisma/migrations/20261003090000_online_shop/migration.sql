-- AlterTable
ALTER TABLE "MessagingSettings" ADD COLUMN     "ordersInCap" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Part" ADD COLUMN     "online" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "onlineText" TEXT,
ADD COLUMN     "onlineTitle" TEXT;

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "nextWebOrderNumber" INTEGER NOT NULL DEFAULT 1001,
ADD COLUMN     "shopFreeOverCents" INTEGER,
ADD COLUMN     "shopOn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "shopPayVia" TEXT NOT NULL DEFAULT 'own',
ADD COLUMN     "shopPickup" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "shopPickupNote" TEXT,
ADD COLUMN     "shopShipCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "shopShipping" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "shopWelcome" TEXT,
ADD COLUMN     "stripeKeySealed" TEXT,
ADD COLUMN     "stripeWebhookSealed" TEXT;

-- CreateTable
CREATE TABLE "PartPhoto" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebOrder" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "customerId" TEXT,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "notify" TEXT NOT NULL DEFAULT '',
    "fulfil" TEXT NOT NULL DEFAULT 'pickup',
    "address" TEXT,
    "items" JSONB NOT NULL DEFAULT '[]',
    "subtotalCents" INTEGER NOT NULL,
    "shipCents" INTEGER NOT NULL DEFAULT 0,
    "taxCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "refundedCents" INTEGER NOT NULL DEFAULT 0,
    "payVia" TEXT NOT NULL DEFAULT 'own',
    "stripeSessionId" TEXT,
    "stripeIntent" TEXT,
    "tokenHash" TEXT NOT NULL,
    "linkSealed" TEXT,
    "saleId" TEXT,
    "tracking" TEXT,
    "note" TEXT,
    "staffNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "doneAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "WebOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PartPhoto_partId_idx" ON "PartPhoto"("partId");

-- CreateIndex
CREATE UNIQUE INDEX "WebOrder_stripeSessionId_key" ON "WebOrder"("stripeSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "WebOrder_tokenHash_key" ON "WebOrder"("tokenHash");

-- CreateIndex
CREATE INDEX "WebOrder_shopId_status_createdAt_idx" ON "WebOrder"("shopId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "WebOrder_customerId_idx" ON "WebOrder"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "WebOrder_shopId_number_key" ON "WebOrder"("shopId", "number");

-- AddForeignKey
ALTER TABLE "PartPhoto" ADD CONSTRAINT "PartPhoto_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartPhoto" ADD CONSTRAINT "PartPhoto_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebOrder" ADD CONSTRAINT "WebOrder_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

