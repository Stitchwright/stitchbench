-- CreateEnum
CREATE TYPE "PhotoKind" AS ENUM ('CONDITION', 'INSIDE', 'WIRING', 'PART', 'AFTER');

-- AlterTable
ALTER TABLE "MachinePhoto" ADD COLUMN     "kind" "PhotoKind" NOT NULL DEFAULT 'CONDITION';

-- AlterTable
ALTER TABLE "ServiceItem" ADD COLUMN     "category" TEXT,
ADD COLUMN     "description" TEXT;

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "priceListNote" TEXT;

-- CreateIndex
CREATE INDEX "MachinePhoto_shopId_kind_idx" ON "MachinePhoto"("shopId", "kind");
