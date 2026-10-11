-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "featuresSetUpAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;

-- Every company already here is from before 1.8: the first time 1.8 loads it, its Features start as the add-ons its
-- license keys (and the hosted switch) had working then (src/lib/modules.ts). A company made from now on starts with
-- every one off.
UPDATE "Shop" SET "featuresSetUpAt" = NULL;

-- CreateTable
CREATE TABLE "ShopFeature" (
    "shopId" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "byName" TEXT,

    CONSTRAINT "ShopFeature_pkey" PRIMARY KEY ("shopId","module")
);

-- AddForeignKey
ALTER TABLE "ShopFeature" ADD CONSTRAINT "ShopFeature_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
