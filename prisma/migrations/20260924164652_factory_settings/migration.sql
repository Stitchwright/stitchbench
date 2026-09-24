-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "measurements" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "FactorySetting" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "models" TEXT NOT NULL,
    "modelKeys" TEXT[],
    "machineType" TEXT,
    "adjustment" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "valueMin" DOUBLE PRECISION,
    "valueMax" DOUBLE PRECISION,
    "unit" TEXT,
    "valueText" TEXT,
    "conditions" TEXT,
    "reference" TEXT,
    "tools" TEXT,
    "sourceFile" TEXT NOT NULL,
    "sourcePath" TEXT,
    "pages" TEXT,
    "figurePage" INTEGER,
    "figureBox" DOUBLE PRECISION[],
    "docType" TEXT,
    "confidence" TEXT,
    "notes" TEXT,

    CONSTRAINT "FactorySetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FactorySetting_brand_idx" ON "FactorySetting"("brand");

-- CreateIndex
CREATE INDEX "FactorySetting_adjustment_idx" ON "FactorySetting"("adjustment");
