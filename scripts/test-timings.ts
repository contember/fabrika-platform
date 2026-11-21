// `bun run test:timings` runs the main suite once, unsharded, against throwaway PostgreSQL and SeaweedFS containers, and
// writes each file's measured duration to `test-timings.json`. CI's shards pass that file to `bun test --timings`, which
// splits the files by total time instead of by count. Nothing regenerates it on its own: run this when the suite's files
// or their durations have changed enough to unbalance the shards, and commit the result. A file missing from it still
// runs; bun only places it without a measured time.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { POSTGRES_MAJORS, removeAllContainers, startPostgres, startSeaweedfs, TEST_TIMINGS_FILE } from './check-ci'

const ROOT = resolve(import.meta.dir, '..')

const spawn = async (command: readonly string[], env: Record<string, string | undefined>): Promise<number> =>
	await Bun.spawn([...command], { cwd: ROOT, env, stdout: 'inherit', stderr: 'inherit' }).exited

const main = async (): Promise<void> => {
	const major = POSTGRES_MAJORS[0]
	if (major === undefined) throw new Error('POSTGRES_MAJORS is empty')
	const scratch = await mkdtemp(join(tmpdir(), 'fabrika-test-timings-'))
	try {
		const [postgres, s3] = await Promise.all([startPostgres(major), startSeaweedfs()])
		const env = { ...process.env, ...postgres.env, ...s3.env }
		// A fresh file, so a deleted or renamed test file does not keep its old entry.
		const measured = join(scratch, 'timings.json')
		const exitCode = await spawn(['bun', 'run', 'test:unit', `--timings=${measured}`, '--update-timings'], env)
		if (exitCode !== 0) throw new Error(`the main suite failed (exit ${exitCode}); ${TEST_TIMINGS_FILE} is unchanged`)
		await Bun.write(join(ROOT, TEST_TIMINGS_FILE), Bun.file(measured))
		if (await spawn(['bun', 'run', 'format', TEST_TIMINGS_FILE], process.env) !== 0) throw new Error(`could not format ${TEST_TIMINGS_FILE}`)
		console.info(`\nWrote ${TEST_TIMINGS_FILE}.`)
	} finally {
		await removeAllContainers()
		await rm(scratch, { recursive: true, force: true })
	}
}

if (import.meta.main) {
	try {
		await main()
	} catch (error) {
		console.error(`test:timings failed: ${error instanceof Error ? error.message : String(error)}`)
		process.exit(1)
	}
}
