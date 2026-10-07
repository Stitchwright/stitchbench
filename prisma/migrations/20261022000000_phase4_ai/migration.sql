-- AlterTable
ALTER TABLE "AssistantSettings" ADD COLUMN     "askOn" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "customerDailyCap" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "customerOn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "marketingOn" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "quiltOn" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "hoursNote" TEXT,
ADD COLUMN     "openHours" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "statusKeyAt" TIMESTAMP(3),
ADD COLUMN     "statusKeyHash" TEXT;

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "pickupTips" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "pickupWhat" TEXT;

-- CreateTable
CREATE TABLE "PatternNeed" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "patternPartId" TEXT NOT NULL,
    "size" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "yards" DOUBLE PRECISION NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatternNeed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CareTip" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CareTip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerQuestion" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT,
    "contact" TEXT,
    "text" TEXT NOT NULL,
    "handledAt" TIMESTAMP(3),
    "handledBy" TEXT,

    CONSTRAINT "CustomerQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PatternNeed_shopId_patternPartId_idx" ON "PatternNeed"("shopId", "patternPartId");

-- CreateIndex
CREATE INDEX "CareTip_shopId_kind_idx" ON "CareTip"("shopId", "kind");

-- CreateIndex
CREATE INDEX "CustomerQuestion_shopId_handledAt_idx" ON "CustomerQuestion"("shopId", "handledAt");

-- AddForeignKey
ALTER TABLE "PatternNeed" ADD CONSTRAINT "PatternNeed_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CareTip" ADD CONSTRAINT "CareTip_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerQuestion" ADD CONSTRAINT "CustomerQuestion_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

