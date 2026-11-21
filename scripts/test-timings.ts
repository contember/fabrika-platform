// `bun run test:timings` runs the main suite once, unsharded, against throwaway PostgreSQL and SeaweedFS containers, and
// writes each file's measured duration to `test-timings.json`. CI's shards pass that file to `bun test --timings`, which
// splits the files by total time instead of by count. Nothing regenerates it on its own: run this when the suite's files
// or their durations have changed enough to unbalance the shards, and commit the result. A file missing from it still
// runs; bun only places it without a measured time.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { POSTGRES_MAJORS, removeAllContainers, startPostgres, startSeaweedfs, TEST_TIMINGS_FILE } from './check-ci'

const ROOT = resolve(import.meta.dir, '..')

/** What bun's `--update-timings` writes and `--timings` reads. */
const timingsSchema = z.object({ version: z.literal(1), files: z.record(z.number()) })

const main = async (scratch: string): Promise<void> => {
	const major = POSTGRES_MAJORS[0]
	if (major === undefined) throw new Error('POSTGRES_MAJORS is empty')
	// One after the other: a start that fails while the other's `docker run` is pending would leave that container behind.
	const postgres = await startPostgres(major)
	const s3 = await startSeaweedfs()
	// A fresh file, so a deleted or renamed test file does not keep its old entry.
	const measured = join(scratch, 'timings.json')
	const command = ['bun', 'run', 'test:unit', `--timings=${measured}`, '--update-timings']
	const exitCode = await Bun.spawn(command, { cwd: ROOT, env: { ...process.env, ...postgres.env, ...s3.env }, stdout: 'inherit', stderr: 'inherit' })
		.exited
	if (exitCode !== 0) throw new Error(`the main suite failed (exit ${exitCode}); ${TEST_TIMINGS_FILE} is unchanged`)
	const timings = timingsSchema.parse(await Bun.file(measured).json())
	// Tabs and a final newline, as dprint formats it.
	await Bun.write(join(ROOT, TEST_TIMINGS_FILE), `${JSON.stringify(timings, null, '\t')}\n`)
	console.info(`\nWrote ${TEST_TIMINGS_FILE}: ${Object.keys(timings.files).length} files.`)
}

if (import.meta.main) {
	const scratch = await mkdtemp(join(tmpdir(), 'fabrika-test-timings-'))
	const cleanUp = async (): Promise<void> => {
		await removeAllContainers()
		await rm(scratch, { recursive: true, force: true })
	}
	const interrupt = (): void => {
		void cleanUp().finally(() => process.exit(130))
	}
	process.on('SIGINT', interrupt)
	process.on('SIGTERM', interrupt)
	try {
		await main(scratch)
	} catch (error) {
		console.error(`test:timings failed: ${error instanceof Error ? error.message : String(error)}`)
		process.exitCode = 1
	} finally {
		await cleanUp()
	}
}
