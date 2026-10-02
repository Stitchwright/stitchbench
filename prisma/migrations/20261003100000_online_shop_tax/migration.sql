-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "shopTaxVia" TEXT NOT NULL DEFAULT 'rate';

-- AlterTable
ALTER TABLE "WebOrder" ADD COLUMN     "taxVia" TEXT NOT NULL DEFAULT 'rate';

