-- AlterTable
ALTER TABLE "Part" ADD COLUMN     "listedOn" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "SaleLine" ADD COLUMN     "soldById" TEXT;

-- AlterTable
ALTER TABLE "StockUnit" ADD COLUMN     "listedOn" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "commission" JSONB NOT NULL DEFAULT '{}';

