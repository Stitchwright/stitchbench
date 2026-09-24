-- CreateTable
CREATE TABLE "LibraryDoc" (
    "id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "file" TEXT NOT NULL,
    "docType" TEXT,
    "title" TEXT,
    "pages" INTEGER,
    "sizeBytes" INTEGER,
    "modelKeys" TEXT[],

    CONSTRAINT "LibraryDoc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelImage" (
    "id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "models" TEXT NOT NULL,
    "modelKeys" TEXT[],
    "sourcePath" TEXT NOT NULL,
    "page" INTEGER NOT NULL,
    "mime" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,

    CONSTRAINT "ModelImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FigureImage" (
    "id" TEXT NOT NULL,
    "sourcePath" TEXT NOT NULL,
    "page" INTEGER NOT NULL,
    "box" DOUBLE PRECISION[],
    "mime" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FigureImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LibraryDoc_path_key" ON "LibraryDoc"("path");

-- CreateIndex
CREATE INDEX "LibraryDoc_brand_idx" ON "LibraryDoc"("brand");

-- CreateIndex
CREATE INDEX "ModelImage_brand_idx" ON "ModelImage"("brand");

-- CreateIndex
CREATE INDEX "FigureImage_sourcePath_page_idx" ON "FigureImage"("sourcePath", "page");
