-- 0027 — A default discount off sale price on an item.
--
-- A starting point for billing, not a binding rule: a till can still
-- override or clear it on any one sale, the same way the item's sale price
-- itself is only ever a default.

SET LOCAL search_path = public, extensions;

ALTER TABLE items
  ADD COLUMN discount_percent NUMERIC(6, 3) CHECK (discount_percent BETWEEN 0 AND 100);
