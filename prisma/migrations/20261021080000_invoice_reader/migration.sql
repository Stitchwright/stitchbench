-- AlterTable
ALTER TABLE "AssistantCall" ADD COLUMN     "purchaseOrderId" TEXT;

-- AlterTable
ALTER TABLE "AssistantSettings" ADD COLUMN     "stockOn" BOOLEAN NOT NULL DEFAULT true;

