-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "sellerAvg" DOUBLE PRECISION,
ADD COLUMN     "sellerCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sellerId" TEXT;

