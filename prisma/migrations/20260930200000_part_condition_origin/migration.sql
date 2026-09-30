-- Parts: condition (new, used, refurbished), who made it (genuine, compatible, 3D printed) and a shop number for a stock
-- item the maker gave no number. Every part that exists becomes New + Genuine, its number as it was.

-- CreateEnum
CREATE TYPE "PartCondition" AS ENUM ('NEW', 'USED', 'REFURB');

-- CreateEnum
CREATE TYPE "PartOrigin" AS ENUM ('GENUINE', 'COMPATIBLE', 'PRINTED');

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "origin" TEXT;

-- AlterTable
ALTER TABLE "Part" ADD COLUMN     "condition" "PartCondition" NOT NULL DEFAULT 'NEW',
ADD COLUMN     "origin" "PartOrigin" NOT NULL DEFAULT 'GENUINE',
ADD COLUMN     "ownNumber" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "nextPartNumber" INTEGER NOT NULL DEFAULT 1;
