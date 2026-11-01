-- AlterTable
ALTER TABLE "DecorOrder" ADD COLUMN     "cardFeeCents" INTEGER,
ADD COLUMN     "feeCents" INTEGER,
ADD COLUMN     "fileError" TEXT,
ADD COLUMN     "fileTries" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "filesNextTryAt" TIMESTAMP(3),
ADD COLUMN     "fulfilment" TEXT,
ADD COLUMN     "onlineFlag" TEXT,
ADD COLUMN     "onlineRef" TEXT,
ADD COLUMN     "paidCents" INTEGER,
ADD COLUMN     "previewSha256" TEXT,
ADD COLUMN     "previewSize" INTEGER,
ADD COLUMN     "shipTo" JSONB,
ADD COLUMN     "shippingPaidCents" INTEGER,
ADD COLUMN     "shopGetsCents" INTEGER,
ADD COLUMN     "source" TEXT,
ADD COLUMN     "taxPaidCents" INTEGER;

-- AlterTable
ALTER TABLE "DecorPlacement" ADD COLUMN     "artSha256" TEXT,
ADD COLUMN     "artSize" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "DecorOrder_shopId_onlineRef_key" ON "DecorOrder"("shopId", "onlineRef");

