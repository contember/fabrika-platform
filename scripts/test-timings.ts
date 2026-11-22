// `bun run test:timings` runs the main suite in CI's shards, as many at once as `check:ci` runs, each against throwaway
// PostgreSQL and SeaweedFS containers of its own, and writes each file's measured duration to `test-timings.json`. CI's
// shards pass that file to `bun test --timings`, which splits the files by total time instead of by count. Nothing
// regenerates it on its own: run this when the suite's files or their durations have changed enough to unbalance the
// shards, and commit the result. A file missing from it still runs; bun only places it without a measured time.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import {
	type Backend,
	POSTGRES_MAJORS,
	removeAllContainers,
	removeContainers,
	startPostgres,
	startSeaweedfs,
	TEST_SHARDS,
	TEST_TIMINGS_FILE,
	testJobWorkers,
} from './check-ci'

const ROOT = resolve(import.meta.dir, '..')

/** What bun's `--update-timings` writes and `--timings` reads. */
const timingsSchema = z.object({ version: z.literal(1), files: z.record(z.number()) })

/** Runs one shard on backends of its own; its measured files go to `output`. Returns the failure, if any. */
const measureShard = async (shard: number, major: string, output: string): Promise<string | undefined> => {
	const opened: Backend[] = []
	try {
		// One after the other: a start that fails while the other's `docker run` is pending would leave that container behind.
		const postgres = await startPostgres(major)
		opened.push(postgres)
		const s3 = await startSeaweedfs()
		opened.push(s3)
		const env = { ...process.env, ...postgres.env, ...s3.env }
		const started = performance.now()
		// bun writes this shard's files to the first `--timings` file, a fresh one, and splits the shards by the committed one.
		const command = [
			'bun',
			'run',
			'test:unit',
			`--shard=${shard}/${TEST_SHARDS.length}`,
			`--timings=${output}`,
			`--timings=${TEST_TIMINGS_FILE}`,
			'--update-timings',
		]
		const child = Bun.spawn(command, { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe' })
		const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
		if (exitCode !== 0) {
			console.error(`\n✗ shard ${shard}/${TEST_SHARDS.length} failed (exit ${exitCode}):\n${stdout}${stderr}`)
			return `shard ${shard}`
		}
		console.info(`✓ shard ${shard}/${TEST_SHARDS.length} (${((performance.now() - started) / 1000).toFixed(1)} s)`)
		return undefined
	} catch (error) {
		return `shard ${shard} (${error instanceof Error ? error.message : String(error)})`
	} finally {
		await removeContainers(opened.flatMap((backend) => backend.container === undefined ? [] : [backend.container]))
	}
}

const main = async (scratch: string): Promise<void> => {
	const major = POSTGRES_MAJORS[0]
	if (major === undefined) throw new Error('POSTGRES_MAJORS is empty')
	const started = performance.now()
	const outputs = TEST_SHARDS.map((shard) => ({ shard, output: join(scratch, `shard-${shard}.json`) }))
	const failed: string[] = []
	let next = 0
	const worker = async (): Promise<void> => {
		for (let job = outputs[next++]; job !== undefined; job = outputs[next++]) {
			const failure = await measureShard(job.shard, major, job.output)
			if (failure !== undefined) failed.push(failure)
		}
	}
	await Promise.all(Array.from({ length: testJobWorkers(outputs.length) }, worker))
	if (failed.length > 0) throw new Error(`${failed.join(', ')} failed; ${TEST_TIMINGS_FILE} is unchanged`)

	const files: Record<string, number> = {}
	for (const { output } of outputs) Object.assign(files, timingsSchema.parse(await Bun.file(output).json()).files)
	const sorted = Object.fromEntries(Object.entries(files).toSorted(([, a], [, b]) => b - a))
	// Tabs and a final newline, as dprint formats it.
	await Bun.write(join(ROOT, TEST_TIMINGS_FILE), `${JSON.stringify({ version: 1, files: sorted }, null, '\t')}\n`)
	const seconds = ((performance.now() - started) / 1000).toFixed(1)
	console.info(`\nWrote ${TEST_TIMINGS_FILE}: ${Object.keys(sorted).length} files, measured in ${seconds} s.`)
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
