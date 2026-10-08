-- AlterTable
ALTER TABLE "PurchaseOrderLine" ADD COLUMN     "backorderedOn" TIMESTAMP(3),
ADD COLUMN     "expectedOn" TEXT;

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "marginFloor" JSONB;

-- CreateTable
CREATE TABLE "PriceChange" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "rule" JSONB NOT NULL,
    "items" JSONB NOT NULL,
    "undoneAt" TIMESTAMP(3),

    CONSTRAINT "PriceChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PriceChange_shopId_at_idx" ON "PriceChange"("shopId", "at");

-- AddForeignKey
ALTER TABLE "PriceChange" ADD CONSTRAINT "PriceChange_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

