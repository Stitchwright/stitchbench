-- AlterTable
ALTER TABLE "ShopOrdersSync" ADD COLUMN     "freeOverCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "offersPickup" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "perExtraPieceCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pickupAddress" JSONB;

