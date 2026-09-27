-- AlterTable: the register's own name for each sale, so a sale sent again after a dropped connection isn't made twice.
-- Existing sales have none (NULLs never clash in a unique index).
ALTER TABLE "Sale" ADD COLUMN     "clientKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Sale_shopId_clientKey_key" ON "Sale"("shopId", "clientKey");
