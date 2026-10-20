-- The last adoption migration of the `attachments` collection: the framework drops its table and lets the sweep
-- delete what no row references.
SELECT fabrika_files_release('attachments');
