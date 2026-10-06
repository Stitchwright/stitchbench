-- CreateEnum
CREATE TYPE "InPrint" AS ENUM ('YES', 'NO', 'UNKNOWN');

-- AlterEnum
ALTER TYPE "MoveReason" ADD VALUE 'CUT';

-- AlterTable
ALTER TABLE "Part" ADD COLUMN     "boltYards" DOUBLE PRECISION NOT NULL DEFAULT 15,
ADD COLUMN     "collection" TEXT,
ADD COLUMN     "colorTags" TEXT[],
ADD COLUMN     "designer" TEXT,
ADD COLUMN     "fatQuarterId" TEXT,
ADD COLUMN     "halfYardId" TEXT,
ADD COLUMN     "inPrint" "InPrint" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "remnantId" TEXT;

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "boltEndYards" DOUBLE PRECISION NOT NULL DEFAULT 1,
ADD COLUMN     "fatQuarterMarkupPct" DOUBLE PRECISION NOT NULL DEFAULT 15,
ADD COLUMN     "halfYardMarkupPct" DOUBLE PRECISION NOT NULL DEFAULT 10,
ADD COLUMN     "remnantPricePct" DOUBLE PRECISION NOT NULL DEFAULT 50;

-- AlterTable
ALTER TABLE "StockMove" ADD COLUMN     "otherPartId" TEXT;

