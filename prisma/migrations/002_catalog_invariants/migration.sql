-- Reviewed SQL-only invariants: Prisma does not express these CHECKs or this
-- partial uniqueness. Do not replace them with application-only validation.
-- No sale flag exists at all. Pricing/stock/virtual bundles are not supported.
BEGIN;
CREATE FUNCTION catalog_is_valid_isbn13(value TEXT) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE WHEN value ~ '^97[89][0-9]{10}$' THEN
    (SELECT SUM(SUBSTRING(value FROM n FOR 1)::INTEGER *
      CASE WHEN n % 2 = 0 THEN 3 ELSE 1 END) % 10 = 0
      FROM generate_series(1, 13) AS n)
    ELSE false END
$$;

CREATE UNIQUE INDEX "SeriesWork_one_primary_per_work"
  ON "SeriesWork"("workId") WHERE "isPrimary" = true;

ALTER TABLE "SeriesWork" ADD CONSTRAINT "SeriesWork_position_positive" CHECK ("position" > 0);
ALTER TABLE "Volume" ADD CONSTRAINT "Volume_sortOrder_positive" CHECK ("sortOrder" > 0);
ALTER TABLE "EditionContent" ADD CONSTRAINT "EditionContent_position_positive" CHECK ("position" > 0);
ALTER TABLE "WorkCategory" ADD CONSTRAINT "WorkCategory_rank_positive" CHECK ("rank" > 0);
ALTER TABLE "WorkContributor" ADD CONSTRAINT "WorkContributor_position_positive" CHECK ("position" > 0);
ALTER TABLE "EditionContributor" ADD CONSTRAINT "EditionContributor_position_positive" CHECK ("position" > 0);
ALTER TABLE "Series" ADD CONSTRAINT "Series_curatedPosition_positive" CHECK ("curatedPosition" > 0);
ALTER TABLE "Category" ADD CONSTRAINT "Category_curatedPosition_positive" CHECK ("curatedPosition" > 0);
ALTER TABLE "Product" ADD CONSTRAINT "Product_curatedPosition_positive" CHECK ("curatedPosition" > 0);
ALTER TABLE "Edition" ADD CONSTRAINT "Edition_year_valid" CHECK ("year" BETWEEN 1 AND 9999);
ALTER TABLE "Edition" ADD CONSTRAINT "Edition_isbn13_valid" CHECK ("isbn13" IS NULL OR catalog_is_valid_isbn13("isbn13"));
ALTER TABLE "Edition" ADD CONSTRAINT "Edition_cover_theme_valid" CHECK (
  "color" IN ('forest', 'clay', 'navy', 'gold', 'plum', 'sage') AND
  "motif" IN ('moon', 'mountain', 'botanical', 'stars', 'waves', 'sun')
);
ALTER TABLE "Edition" ADD CONSTRAINT "Edition_display_labels_nonblank" CHECK (
  length(btrim("editionLabel")) > 0 AND length(btrim("contentLabel")) > 0 AND length(btrim("languageLabel")) > 0
);
ALTER TABLE "Product" ADD CONSTRAINT "Product_published_primary_sku" CHECK (
  "status" <> 'PUBLISHED' OR "primarySkuId" IS NOT NULL
);
ALTER TABLE "Sku" ADD CONSTRAINT "Sku_physical_identity" CHECK (
  ("kind" = 'SINGLE_BOOK' AND "editionId" IS NOT NULL) OR
  ("kind" = 'PREPACKED' AND "editionId" IS NULL)
);
-- Published completeness across EditionContent/Work and eligible primary SKU
-- is checked by public read eligibility/use cases, not a cross-table CHECK.
-- Draft Product may omit primary SKU; primary ownership itself is a base FK.
ALTER TABLE "Work" ADD CONSTRAINT "Work_version_nonnegative" CHECK ("version" >= 0);
ALTER TABLE "Series" ADD CONSTRAINT "Series_version_nonnegative" CHECK ("version" >= 0);
ALTER TABLE "Edition" ADD CONSTRAINT "Edition_version_nonnegative" CHECK ("version" >= 0);
ALTER TABLE "Product" ADD CONSTRAINT "Product_version_nonnegative" CHECK ("version" >= 0);
ALTER TABLE "Category" ADD CONSTRAINT "Category_version_nonnegative" CHECK ("version" >= 0);
ALTER TABLE "Contributor" ADD CONSTRAINT "Contributor_version_nonnegative" CHECK ("version" >= 0);
ALTER TABLE "Publisher" ADD CONSTRAINT "Publisher_version_nonnegative" CHECK ("version" >= 0);
COMMIT;
