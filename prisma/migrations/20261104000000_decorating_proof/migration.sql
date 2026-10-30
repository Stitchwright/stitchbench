-- AlterTable
ALTER TABLE "DecorOrder" ADD COLUMN     "mockupData" BYTEA,
ADD COLUMN     "mockupMime" TEXT,
ADD COLUMN     "mockupName" TEXT;

-- AlterTable
ALTER TABLE "EstimateLink" ADD COLUMN     "decorOrderId" TEXT;

-- CreateIndex
CREATE INDEX "EstimateLink_shopId_decorOrderId_idx" ON "EstimateLink"("shopId", "decorOrderId");

