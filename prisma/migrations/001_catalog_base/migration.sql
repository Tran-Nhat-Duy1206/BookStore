-- Batch 3.1 base: ordinary relations/uniques/indexes are mirrored in Prisma.
-- This baseline intentionally precedes reviewed cross-field invariants in 002.
BEGIN;
CREATE TYPE "PublicationStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE "ContributorRole" AS ENUM ('AUTHOR', 'TRANSLATOR', 'ILLUSTRATOR', 'EDITOR');
CREATE TYPE "SkuKind" AS ENUM ('SINGLE_BOOK', 'PREPACKED');

CREATE TABLE "Work" (
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "version" INTEGER NOT NULL DEFAULT 0,
 "id" UUID NOT NULL, "publicId" TEXT NOT NULL, "slug" TEXT NOT NULL,
 "title" TEXT NOT NULL, "description" TEXT,
 "status" "PublicationStatus" NOT NULL DEFAULT 'DRAFT', "isDemo" BOOLEAN NOT NULL DEFAULT true,
 CONSTRAINT "Work_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Series" (
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "version" INTEGER NOT NULL DEFAULT 0,
 "id" UUID NOT NULL, "publicId" TEXT NOT NULL, "slug" TEXT NOT NULL,
 "title" TEXT NOT NULL, "description" TEXT NOT NULL, "curatedPosition" INTEGER NOT NULL,
 "status" "PublicationStatus" NOT NULL DEFAULT 'DRAFT', "isDemo" BOOLEAN NOT NULL DEFAULT true,
 CONSTRAINT "Series_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "SeriesWork" (
 "seriesId" UUID NOT NULL, "workId" UUID NOT NULL, "position" INTEGER NOT NULL,
 "isPrimary" BOOLEAN NOT NULL DEFAULT false, "isDemo" BOOLEAN NOT NULL DEFAULT true,
 CONSTRAINT "SeriesWork_pkey" PRIMARY KEY ("seriesId", "workId")
);
CREATE TABLE "Volume" (
 "id" UUID NOT NULL, "publicId" TEXT NOT NULL, "workId" UUID NOT NULL,
 "label" TEXT, "sortOrder" INTEGER NOT NULL, "isDemo" BOOLEAN NOT NULL DEFAULT true,
 CONSTRAINT "Volume_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Publisher" (
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "version" INTEGER NOT NULL DEFAULT 0,
 "id" UUID NOT NULL, "publicId" TEXT NOT NULL, "name" TEXT NOT NULL,
 "isDemo" BOOLEAN NOT NULL DEFAULT true, CONSTRAINT "Publisher_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Edition" (
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "version" INTEGER NOT NULL DEFAULT 0,
 "id" UUID NOT NULL, "publicId" TEXT NOT NULL, "editionLabel" TEXT NOT NULL,
 "contentLabel" TEXT NOT NULL, "languageLabel" TEXT NOT NULL, "year" INTEGER,
 "color" TEXT NOT NULL, "motif" TEXT NOT NULL, "isbn13" TEXT, "publisherId" UUID,
 "status" "PublicationStatus" NOT NULL DEFAULT 'DRAFT', "isDemo" BOOLEAN NOT NULL DEFAULT true,
 CONSTRAINT "Edition_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "EditionContent" (
 "editionId" UUID NOT NULL, "volumeId" UUID NOT NULL, "position" INTEGER NOT NULL,
 "isDemo" BOOLEAN NOT NULL DEFAULT true,
 CONSTRAINT "EditionContent_pkey" PRIMARY KEY ("editionId", "volumeId")
);
CREATE TABLE "Product" (
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "version" INTEGER NOT NULL DEFAULT 0,
 "id" UUID NOT NULL, "publicId" TEXT NOT NULL, "slug" TEXT NOT NULL,
 "merchandisingTitle" TEXT NOT NULL, "description" TEXT NOT NULL, "eyebrow" TEXT NOT NULL,
 "curatedPosition" INTEGER NOT NULL, "status" "PublicationStatus" NOT NULL DEFAULT 'DRAFT',
 "primarySkuId" UUID, "isDemo" BOOLEAN NOT NULL DEFAULT true,
 CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Sku" (
 "id" UUID NOT NULL, "publicId" TEXT NOT NULL, "code" TEXT NOT NULL,
 "productId" UUID NOT NULL, "editionId" UUID,
 "kind" "SkuKind" NOT NULL DEFAULT 'SINGLE_BOOK', "isDemo" BOOLEAN NOT NULL DEFAULT true,
 CONSTRAINT "Sku_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Category" (
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "version" INTEGER NOT NULL DEFAULT 0,
 "id" UUID NOT NULL, "publicId" TEXT NOT NULL, "slug" TEXT NOT NULL,
 "label" TEXT NOT NULL, "description" TEXT NOT NULL, "curatedPosition" INTEGER NOT NULL,
 "isDemo" BOOLEAN NOT NULL DEFAULT true, CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "WorkCategory" (
 "workId" UUID NOT NULL, "categoryId" UUID NOT NULL, "rank" INTEGER NOT NULL,
 "isDemo" BOOLEAN NOT NULL DEFAULT true,
 CONSTRAINT "WorkCategory_pkey" PRIMARY KEY ("workId", "categoryId")
);
CREATE TABLE "Contributor" (
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "version" INTEGER NOT NULL DEFAULT 0,
 "id" UUID NOT NULL, "publicId" TEXT NOT NULL, "name" TEXT NOT NULL,
 "isDemo" BOOLEAN NOT NULL DEFAULT true, CONSTRAINT "Contributor_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "WorkContributor" (
 "workId" UUID NOT NULL, "contributorId" UUID NOT NULL, "role" "ContributorRole" NOT NULL,
 "position" INTEGER NOT NULL, "isDemo" BOOLEAN NOT NULL DEFAULT true,
 CONSTRAINT "WorkContributor_pkey" PRIMARY KEY ("workId", "contributorId", "role")
);
CREATE TABLE "EditionContributor" (
 "editionId" UUID NOT NULL, "contributorId" UUID NOT NULL, "role" "ContributorRole" NOT NULL,
 "position" INTEGER NOT NULL, "isDemo" BOOLEAN NOT NULL DEFAULT true,
 CONSTRAINT "EditionContributor_pkey" PRIMARY KEY ("editionId", "contributorId", "role")
);

CREATE UNIQUE INDEX "Work_publicId_key" ON "Work"("publicId");
CREATE UNIQUE INDEX "Work_slug_key" ON "Work"("slug");
CREATE UNIQUE INDEX "Series_publicId_key" ON "Series"("publicId");
CREATE UNIQUE INDEX "Series_slug_key" ON "Series"("slug");
CREATE UNIQUE INDEX "Series_curatedPosition_key" ON "Series"("curatedPosition");
CREATE UNIQUE INDEX "SeriesWork_seriesId_position_key" ON "SeriesWork"("seriesId", "position");
CREATE INDEX "SeriesWork_workId_idx" ON "SeriesWork"("workId");
CREATE UNIQUE INDEX "Volume_publicId_key" ON "Volume"("publicId");
CREATE UNIQUE INDEX "Volume_workId_sortOrder_key" ON "Volume"("workId", "sortOrder");
CREATE UNIQUE INDEX "Publisher_publicId_key" ON "Publisher"("publicId");
CREATE UNIQUE INDEX "Edition_publicId_key" ON "Edition"("publicId");
CREATE UNIQUE INDEX "Edition_isbn13_key" ON "Edition"("isbn13");
CREATE INDEX "Edition_publisherId_idx" ON "Edition"("publisherId");
CREATE UNIQUE INDEX "EditionContent_editionId_position_key" ON "EditionContent"("editionId", "position");
CREATE INDEX "EditionContent_volumeId_idx" ON "EditionContent"("volumeId");
CREATE UNIQUE INDEX "Product_publicId_key" ON "Product"("publicId");
CREATE UNIQUE INDEX "Product_slug_key" ON "Product"("slug");
CREATE UNIQUE INDEX "Product_curatedPosition_key" ON "Product"("curatedPosition");
CREATE INDEX "Product_id_primarySkuId_idx" ON "Product"("id", "primarySkuId");
CREATE UNIQUE INDEX "Sku_publicId_key" ON "Sku"("publicId");
CREATE UNIQUE INDEX "Sku_code_key" ON "Sku"("code");
CREATE UNIQUE INDEX "Sku_productId_id_key" ON "Sku"("productId", "id");
CREATE INDEX "Sku_editionId_idx" ON "Sku"("editionId");
CREATE UNIQUE INDEX "Category_publicId_key" ON "Category"("publicId");
CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");
CREATE UNIQUE INDEX "Category_curatedPosition_key" ON "Category"("curatedPosition");
CREATE UNIQUE INDEX "WorkCategory_workId_rank_key" ON "WorkCategory"("workId", "rank");
CREATE INDEX "WorkCategory_categoryId_idx" ON "WorkCategory"("categoryId");
CREATE UNIQUE INDEX "Contributor_publicId_key" ON "Contributor"("publicId");
CREATE UNIQUE INDEX "WorkContributor_workId_role_position_key" ON "WorkContributor"("workId", "role", "position");
CREATE INDEX "WorkContributor_contributorId_idx" ON "WorkContributor"("contributorId");
CREATE UNIQUE INDEX "EditionContributor_editionId_role_position_key" ON "EditionContributor"("editionId", "role", "position");
CREATE INDEX "EditionContributor_contributorId_idx" ON "EditionContributor"("contributorId");

ALTER TABLE "SeriesWork" ADD CONSTRAINT "SeriesWork_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "Series"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SeriesWork" ADD CONSTRAINT "SeriesWork_workId_fkey" FOREIGN KEY ("workId") REFERENCES "Work"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Volume" ADD CONSTRAINT "Volume_workId_fkey" FOREIGN KEY ("workId") REFERENCES "Work"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Edition" ADD CONSTRAINT "Edition_publisherId_fkey" FOREIGN KEY ("publisherId") REFERENCES "Publisher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EditionContent" ADD CONSTRAINT "EditionContent_editionId_fkey" FOREIGN KEY ("editionId") REFERENCES "Edition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EditionContent" ADD CONSTRAINT "EditionContent_volumeId_fkey" FOREIGN KEY ("volumeId") REFERENCES "Volume"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Sku" ADD CONSTRAINT "Sku_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Sku" ADD CONSTRAINT "Sku_editionId_fkey" FOREIGN KEY ("editionId") REFERENCES "Edition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Supported composite ownership FK stays in base and in Prisma, not custom 002.
ALTER TABLE "Product" ADD CONSTRAINT "Product_id_primarySkuId_fkey" FOREIGN KEY ("id", "primarySkuId") REFERENCES "Sku"("productId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "WorkCategory" ADD CONSTRAINT "WorkCategory_workId_fkey" FOREIGN KEY ("workId") REFERENCES "Work"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkCategory" ADD CONSTRAINT "WorkCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkContributor" ADD CONSTRAINT "WorkContributor_workId_fkey" FOREIGN KEY ("workId") REFERENCES "Work"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkContributor" ADD CONSTRAINT "WorkContributor_contributorId_fkey" FOREIGN KEY ("contributorId") REFERENCES "Contributor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EditionContributor" ADD CONSTRAINT "EditionContributor_editionId_fkey" FOREIGN KEY ("editionId") REFERENCES "Edition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EditionContributor" ADD CONSTRAINT "EditionContributor_contributorId_fkey" FOREIGN KEY ("contributorId") REFERENCES "Contributor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
COMMIT;
