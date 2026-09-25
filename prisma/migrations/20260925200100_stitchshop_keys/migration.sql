-- AlterTable
ALTER TABLE "ConsignSale" DROP CONSTRAINT "ConsignSale_pkey",
ADD CONSTRAINT "ConsignSale_pkey" PRIMARY KEY ("shopId", "id");

-- AlterTable
ALTER TABLE "PartnerLink" DROP CONSTRAINT "PartnerLink_pkey",
ADD CONSTRAINT "PartnerLink_pkey" PRIMARY KEY ("shopId", "id");

-- AlterTable
ALTER TABLE "PartnerOrder" DROP CONSTRAINT "PartnerOrder_pkey",
ADD CONSTRAINT "PartnerOrder_pkey" PRIMARY KEY ("shopId", "id");

-- AlterTable
ALTER TABLE "RepairJob" DROP CONSTRAINT "RepairJob_pkey",
ADD CONSTRAINT "RepairJob_pkey" PRIMARY KEY ("shopId", "id");

-- AlterTable
ALTER TABLE "Settlement" DROP CONSTRAINT "Settlement_pkey",
ADD CONSTRAINT "Settlement_pkey" PRIMARY KEY ("shopId", "id");

