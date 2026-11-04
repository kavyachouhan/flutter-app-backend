-- 0028 — Item photos, category icons, and files attached to records.
--
-- Files live in the private Storage bucket, never in Postgres: a row carries
-- only the *object key* (`{tenant_id}/{kind}/{uuid}.{ext}`), because a URL
-- expires and a blob would bloat every sync pull. Keys are tenant-prefixed, so
-- each business's files sit in their own folder of the bucket.
--
-- Nothing here is backfilled: every column is optional, and existing rows
-- simply have no picture, icon or attachment.

SET LOCAL search_path = public, extensions;

-- One photo per item. Mutable like the rest of the item.
ALTER TABLE items
  ADD COLUMN image_object_key TEXT CHECK (length(image_object_key) BETWEEN 1 AND 512);

-- A category icon is the *name* of an icon the app ships with (an SVG in its
-- own assets), never an uploaded image: letting people upload SVG would put a
-- script-execution surface in front of everyone who opens the list.
ALTER TABLE categories
  ADD COLUMN icon TEXT CHECK (icon ~ '^[a-z0-9][a-z0-9_-]{0,63}$');
ALTER TABLE expense_categories
  ADD COLUMN icon TEXT CHECK (icon ~ '^[a-z0-9][a-z0-9_-]{0,63}$');

-- Files attached to a document: a JSON array of
--   { objectKey, kind: 'image'|'document', name, contentType?, sizeBytes?, encoding? }
-- (the shape sale orders already use). Documents that are immutable once
-- issued take their attachments at creation, like every other field on them.
ALTER TABLE expenses
  ADD COLUMN attachments JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(attachments) = 'array' AND jsonb_array_length(attachments) <= 10);
ALTER TABLE invoices
  ADD COLUMN attachments JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(attachments) = 'array' AND jsonb_array_length(attachments) <= 10);
ALTER TABLE purchase_bills
  ADD COLUMN attachments JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(attachments) = 'array' AND jsonb_array_length(attachments) <= 10);
ALTER TABLE purchase_orders
  ADD COLUMN attachments JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(attachments) = 'array' AND jsonb_array_length(attachments) <= 10);

SELECT app.grant_runtime_privileges();
