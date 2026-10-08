-- AlterTable
ALTER TABLE "Part" ADD COLUMN     "fitGroupIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "fitsKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "fitsModels" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "FitGroup" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "models" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "modelKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FitGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FitGroup_modelKeys_idx" ON "FitGroup" USING GIN ("modelKeys");

-- CreateIndex
CREATE UNIQUE INDEX "FitGroup_shopId_name_key" ON "FitGroup"("shopId", "name");

-- CreateIndex
CREATE INDEX "Part_fitsKeys_idx" ON "Part" USING GIN ("fitsKeys");

-- AddForeignKey
ALTER TABLE "FitGroup" ADD CONSTRAINT "FitGroup_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

