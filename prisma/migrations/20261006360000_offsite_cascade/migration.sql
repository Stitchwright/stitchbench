-- AddForeignKey
ALTER TABLE "OffsiteObject" ADD CONSTRAINT "OffsiteObject_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OffsiteRun" ADD CONSTRAINT "OffsiteRun_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

