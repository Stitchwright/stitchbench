-- CreateTable
CREATE TABLE "ServiceMode" (
    "id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "models" TEXT NOT NULL,
    "modelKeys" TEXT[],
    "category" TEXT,
    "mode" TEXT NOT NULL,
    "enterSteps" TEXT[],
    "exitSteps" TEXT[],
    "tests" JSONB NOT NULL,
    "cautions" TEXT,
    "sourceFile" TEXT NOT NULL,
    "sourcePath" TEXT,
    "pages" TEXT,
    "page" INTEGER,
    "figurePage" INTEGER,
    "figureBox" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[],
    "confidence" TEXT,
    "notes" TEXT,

    CONSTRAINT "ServiceMode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServiceMode_brand_idx" ON "ServiceMode"("brand");

