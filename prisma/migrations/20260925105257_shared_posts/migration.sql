-- CreateTable
CREATE TABLE "SharedPost" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "authorId" TEXT,
    "brand" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "modelKey" TEXT NOT NULL,
    "kind" "NoteKind" NOT NULL DEFAULT 'GOTCHA',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SharedPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SharedPhoto" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "kind" "PhotoKind" NOT NULL,
    "caption" TEXT,
    "mime" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SharedPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SharedPost_modelKey_idx" ON "SharedPost"("modelKey");

-- CreateIndex
CREATE INDEX "SharedPost_createdAt_idx" ON "SharedPost"("createdAt");

-- CreateIndex
CREATE INDEX "SharedPhoto_postId_idx" ON "SharedPhoto"("postId");

-- AddForeignKey
ALTER TABLE "SharedPost" ADD CONSTRAINT "SharedPost_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SharedPost" ADD CONSTRAINT "SharedPost_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SharedPhoto" ADD CONSTRAINT "SharedPhoto_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SharedPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
