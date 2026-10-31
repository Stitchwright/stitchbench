-- AlterTable
ALTER TABLE "ShopOrdersSync" ADD COLUMN     "shippingCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "shipsOrders" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "OnlineProduct" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'shirt',
    "colours" TEXT NOT NULL,
    "sizes" TEXT NOT NULL,
    "blankCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnlineProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnlineOffer" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "placement" TEXT NOT NULL,
    "breaks" JSONB NOT NULL,
    "setupCents" INTEGER NOT NULL DEFAULT 0,
    "maxStitches" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnlineOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OnlineProduct_shopId_sku_key" ON "OnlineProduct"("shopId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "OnlineOffer_shopId_method_placement_key" ON "OnlineOffer"("shopId", "method", "placement");

-- AddForeignKey
ALTER TABLE "OnlineProduct" ADD CONSTRAINT "OnlineProduct_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "ShopOrdersSync"("shopId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnlineOffer" ADD CONSTRAINT "OnlineOffer_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "ShopOrdersSync"("shopId") ON DELETE CASCADE ON UPDATE CASCADE;

