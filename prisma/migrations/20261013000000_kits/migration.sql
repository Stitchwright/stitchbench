-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "fabBundleDiscountPct" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "fabKitMarginPct" INTEGER NOT NULL DEFAULT 50;

-- CreateTable
CREATE TABLE "Kit" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "note" TEXT,
    "patternPartId" TEXT,
    "patternNote" TEXT,
    "patternCostCents" INTEGER NOT NULL DEFAULT 0,
    "priceCents" INTEGER,
    "partId" TEXT,
    "seriesId" TEXT,
    "seriesMonth" INTEGER,
    "handoutDoneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Kit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KitLine" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "kitId" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "KitLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KitSeries" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "months" INTEGER NOT NULL DEFAULT 12,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KitSeries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KitSeriesMember" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "note" TEXT,
    "signedUpAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KitSeriesMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Kit_shopId_idx" ON "Kit"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "Kit_seriesId_seriesMonth_key" ON "Kit"("seriesId", "seriesMonth");

-- CreateIndex
CREATE INDEX "KitLine_shopId_partId_idx" ON "KitLine"("shopId", "partId");

-- CreateIndex
CREATE UNIQUE INDEX "KitLine_kitId_partId_key" ON "KitLine"("kitId", "partId");

-- CreateIndex
CREATE INDEX "KitSeries_shopId_idx" ON "KitSeries"("shopId");

-- CreateIndex
CREATE INDEX "KitSeriesMember_shopId_idx" ON "KitSeriesMember"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "KitSeriesMember_seriesId_customerId_key" ON "KitSeriesMember"("seriesId", "customerId");

-- AddForeignKey
ALTER TABLE "Kit" ADD CONSTRAINT "Kit_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Kit" ADD CONSTRAINT "Kit_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Kit" ADD CONSTRAINT "Kit_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "KitSeries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitLine" ADD CONSTRAINT "KitLine_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitLine" ADD CONSTRAINT "KitLine_kitId_fkey" FOREIGN KEY ("kitId") REFERENCES "Kit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitLine" ADD CONSTRAINT "KitLine_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitSeries" ADD CONSTRAINT "KitSeries_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitSeriesMember" ADD CONSTRAINT "KitSeriesMember_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitSeriesMember" ADD CONSTRAINT "KitSeriesMember_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "KitSeries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitSeriesMember" ADD CONSTRAINT "KitSeriesMember_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

