-- AlterTable
ALTER TABLE "FabricSupplier" ADD COLUMN     "accountNumber" TEXT,
ADD COLUMN     "catalogAt" TIMESTAMP(3),
ADD COLUMN     "catalogMap" JSONB,
ADD COLUMN     "catalogNote" TEXT,
ADD COLUMN     "connector" TEXT NOT NULL DEFAULT 'email',
ADD COLUMN     "orderLayout" JSONB;

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "sentVia" TEXT;

