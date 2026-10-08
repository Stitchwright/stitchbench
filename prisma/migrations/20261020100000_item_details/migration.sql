-- AlterTable
ALTER TABLE "Part" ADD COLUMN     "colorHex" TEXT,
ADD COLUMN     "colorName" TEXT,
ADD COLUMN     "colorNumber" TEXT,
ADD COLUMN     "itemType" TEXT,
ADD COLUMN     "material" TEXT,
ADD COLUMN     "specs" JSONB;

-- CreateIndex
CREATE INDEX "Part_shopId_itemType_idx" ON "Part"("shopId", "itemType");

