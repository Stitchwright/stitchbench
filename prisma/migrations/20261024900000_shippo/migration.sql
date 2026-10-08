-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "shipFrom" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "shipParcel" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "shippoKeySealed" TEXT,
ADD COLUMN     "shippoOn" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "WebOrder" ADD COLUMN     "labelCarrier" TEXT,
ADD COLUMN     "labelCents" INTEGER,
ADD COLUMN     "labelUrl" TEXT,
ADD COLUMN     "shippoTxId" TEXT;

