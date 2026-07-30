// @fabrika/platform-node — every `@fabrika/platform` port implemented for a LONG-RUNNING BUN PROCESS.
//
// This is the second implementation set behind the ports (the first being the Cloudflare bindings that
// live with the workers using them), and the one ADR-0003 needs: on Zerops the control plane executes
// the deploy itself, in a process, so it needs Postgres instead of D1, S3 instead of R2, a job table
// instead of Cloudflare Queues, a lock row instead of a Durable Object, and a directory instead of an
// `ASSETS` binding.
//
//   SqlDatabase  → PostgresDatabase       (Bun.SQL; `?` → `$n` via a real tokeniser)
//   BlobStore    → S3BlobStore            (Bun.S3Client; one impl for R2 and MinIO alike)
//   JobQueue     → PostgresJobQueue       (+ PostgresJobConsumer, the poller the port omits by design)
//   DeployLocks  → (none — @fabrika/platform's `SqlDeployLocks` needs nothing but the SqlDatabase
//                   port, so it is runtime-neutral and lives there; import it from @fabrika/platform)
//   AssetServer  → FileSystemAssetServer  (built SPA directory + SPA fallback)
//   WaitUntil    → createBackgroundTasks  (supervised promises; rejections logged, never fatal)
//
// Dependencies: none beyond `@fabrika/platform` itself. Everything else is a Bun built-in.
// Migrations for what this package owns (the jobs table, the Postgres lock table) live in
// `migrations/` — DDL is per-dialect even when the statement over it is portable.

export { FileSystemAssetServer, type FileSystemAssetServerOptions } from './asset-server-fs'
export { S3BlobStore, type S3BlobStoreOptions } from './blob-s3'
export { type Job, PostgresJobConsumer, type PostgresJobConsumerOptions, PostgresJobQueue, type PostgresJobQueueOptions } from './job-queue-postgres'
export { rewritePlaceholders, type RewrittenSql } from './placeholders'
export {
	applyPostgresMigrations,
	definePostgresMigrationPlan,
	platformNodePostgresMigrationBundle,
	type PostgresLegacyMigrationEffect,
	type PostgresLegacyMigrationLedger,
	type PostgresMigration,
	type PostgresMigrationBundle,
	postgresMigrationFilenames,
	postgresMigrationIdentity,
	type PostgresMigrationPlan,
	readPostgresMigrationBundle,
	type ReadPostgresMigrationBundleOptions,
} from './postgres-migrations'
export { PostgresDatabase, PostgresStatement, type SqlBindValue } from './sql-postgres'
export { uuidv7 } from './uuid'
export { type BackgroundTasks, type BackgroundTasksOptions, createBackgroundTasks } from './wait-until'
