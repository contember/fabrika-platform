-- The installation's client logo on fabrika's own pages (ADR-0066). SQLite/D1 dialect;
-- `../migrations-postgres/0021_installation_brand.sql` states the same outcome.
--
-- An installation serves one client, so this is one row or none: `id` is always 1. An installation administrator sets
-- it through IAM's administration API, which checks each image with `brandImageProblem` (`@fabrika/proxy-core/brand`)
-- and IAM checks it again at every read, so the image types are not checked here. A clear keeps the row with no
-- images, so `updated_at` still says when the brand last changed. No row, or a row without a light image, is no brand:
-- the pages draw the fabrika mark, as every installation did before this file.
CREATE TABLE installation_brand (
	id           INTEGER PRIMARY KEY CHECK (id = 1),
	light_type   TEXT,
	light_base64 TEXT,
	dark_type    TEXT,
	dark_base64  TEXT,
	updated_at   INTEGER NOT NULL,
	CHECK ((light_type IS NULL) = (light_base64 IS NULL)),
	CHECK ((dark_type IS NULL) = (dark_base64 IS NULL)),
	CHECK (dark_type IS NULL OR light_type IS NOT NULL)
);
