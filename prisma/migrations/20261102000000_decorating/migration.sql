-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "nextDecorOrderNumber" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "DecorSettings" (
    "shopId" TEXT NOT NULL,
    "prices" JSONB,

    CONSTRAINT "DecorSettings_pkey" PRIMARY KEY ("shopId")
);

-- CreateTable
CREATE TABLE "DecorOrder" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "locationId" TEXT,
    "number" INTEGER NOT NULL,
    "customerId" TEXT,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUOTED',
    "dueAt" TIMESTAMP(3),
    "note" TEXT,
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "quoteCents" INTEGER NOT NULL DEFAULT 0,
    "digitizingCents" INTEGER NOT NULL DEFAULT 0,
    "setupCents" INTEGER NOT NULL DEFAULT 0,
    "turnedDownWhy" TEXT,
    "saleId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "collectedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DecorOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DecorLine" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL,
    "color" TEXT,
    "sizes" TEXT,
    "qty" INTEGER NOT NULL,
    "garmentCents" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DecorLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DecorPlacement" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "location" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'EMBROIDERY',
    "stitches" INTEGER NOT NULL DEFAULT 0,
    "colors" INTEGER NOT NULL DEFAULT 1,
    "widthMm" DOUBLE PRECISION,
    "heightMm" DOUBLE PRECISION,
    "newDesign" BOOLEAN NOT NULL DEFAULT false,
    "priceEachCents" INTEGER,
    "quotedEachCents" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "fileName" TEXT,
    "fileFormat" TEXT,
    "fileData" BYTEA,
    "fileReadable" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "DecorPlacement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DecorOrder_shopId_status_idx" ON "DecorOrder"("shopId", "status");

-- CreateIndex
CREATE INDEX "DecorOrder_shopId_customerId_idx" ON "DecorOrder"("shopId", "customerId");

-- CreateIndex
CREATE INDEX "DecorOrder_shopId_locationId_idx" ON "DecorOrder"("shopId", "locationId");

-- CreateIndex
CREATE UNIQUE INDEX "DecorOrder_shopId_number_key" ON "DecorOrder"("shopId", "number");

-- CreateIndex
CREATE INDEX "DecorLine_orderId_idx" ON "DecorLine"("orderId");

-- CreateIndex
CREATE INDEX "DecorLine_shopId_idx" ON "DecorLine"("shopId");

-- CreateIndex
CREATE INDEX "DecorPlacement_orderId_idx" ON "DecorPlacement"("orderId");

-- CreateIndex
CREATE INDEX "DecorPlacement_shopId_idx" ON "DecorPlacement"("shopId");

-- AddForeignKey
ALTER TABLE "DecorSettings" ADD CONSTRAINT "DecorSettings_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecorOrder" ADD CONSTRAINT "DecorOrder_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecorOrder" ADD CONSTRAINT "DecorOrder_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecorLine" ADD CONSTRAINT "DecorLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "DecorOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecorPlacement" ADD CONSTRAINT "DecorPlacement_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "DecorOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

