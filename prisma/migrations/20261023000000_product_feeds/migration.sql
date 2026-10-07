-- AlterTable
ALTER TABLE "Part" ADD COLUMN     "gtin" TEXT;

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "feedStoreCode" TEXT,
ADD COLUMN     "feedToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Shop_feedToken_key" ON "Shop"("feedToken");

