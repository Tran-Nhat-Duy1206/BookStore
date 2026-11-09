-- Additive integrity hardening after base/invariants. Never rewrite applied SQL.
BEGIN;
ALTER TABLE "Work" ADD CONSTRAINT "Work_public_identity" CHECK (length("publicId") > 0 AND "publicId" = btrim("publicId") AND length(btrim("slug")) > 0 AND "slug" !~ '[/?#[:space:]]');
ALTER TABLE "Series" ADD CONSTRAINT "Series_public_identity" CHECK (length("publicId") > 0 AND "publicId" = btrim("publicId") AND length(btrim("slug")) > 0 AND "slug" !~ '[/?#[:space:]]');
ALTER TABLE "Volume" ADD CONSTRAINT "Volume_public_identity" CHECK (length("publicId") > 0 AND "publicId" = btrim("publicId"));
ALTER TABLE "Edition" ADD CONSTRAINT "Edition_public_identity" CHECK (length("publicId") > 0 AND "publicId" = btrim("publicId"));
ALTER TABLE "Product" ADD CONSTRAINT "Product_public_identity" CHECK (length("publicId") > 0 AND "publicId" = btrim("publicId") AND length(btrim("slug")) > 0 AND "slug" !~ '[/?#[:space:]]');
ALTER TABLE "Sku" ADD CONSTRAINT "Sku_public_identity" CHECK (length("publicId") > 0 AND "publicId" = btrim("publicId") AND length(btrim("code")) > 0);
ALTER TABLE "Category" ADD CONSTRAINT "Category_public_identity" CHECK (length("publicId") > 0 AND "publicId" = btrim("publicId") AND length(btrim("slug")) > 0 AND "slug" !~ '[/?#[:space:]]');
ALTER TABLE "Contributor" ADD CONSTRAINT "Contributor_public_identity" CHECK (length("publicId") > 0 AND "publicId" = btrim("publicId") AND length(btrim("name")) > 0);
ALTER TABLE "Publisher" ADD CONSTRAINT "Publisher_public_identity" CHECK (length("publicId") > 0 AND "publicId" = btrim("publicId") AND length(btrim("name")) > 0);
CREATE INDEX "Product_status_curatedPosition_idx" ON "Product"("status", "curatedPosition");
CREATE INDEX "Series_status_curatedPosition_idx" ON "Series"("status", "curatedPosition");
COMMIT;
