// `bun run check:ci` runs locally what `.github/workflows/ci.yml` runs, in the same order, so a green run here is a
// green CI run. `release.yml` calls that workflow as its `verify` job, so this is also the gate a tag must pass.
//
// Each job of the test matrix (PostgreSQL major × shard) gets its own throwaway PostgreSQL and SeaweedFS containers on
// random loopback ports, as each CI job gets its own runner, and the jobs run concurrently. A backend the environment
// already names is used as it is, by one job at a time. What cannot run here — no docker, no npm — is skipped and named
// in the summary, never silently.
// `scripts/__tests__/check-ci.test.ts` fails when these steps and `ci.yml` drift apart.

import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')

export interface CiStep {
	/** The `ci.yml` job the step belongs to. */
	readonly job: string
	/** The step's `name` in `ci.yml`. */
	readonly name: string
	/** The step's `run` in `ci.yml`, run with bash as GitHub Actions runs it. */
	readonly run: string
}

/** Every job of `ci.yml` starts with this step; it runs once, first. */
export const INSTALL_STEP: CiStep = { job: 'quality', name: 'Install dependencies', run: 'bun install --frozen-lockfile' }

export const QUALITY_STEPS: readonly CiStep[] = [
	{ job: 'quality', name: 'Check formatting', run: 'bun run format:check' },
	{ job: 'quality', name: 'Lint', run: 'bun run lint' },
	{ job: 'quality', name: 'Typecheck', run: 'bun run typecheck' },
	{ job: 'quality', name: 'Typecheck the examples with their own TypeScript', run: "bun run --filter 'fabrika-example-*' typecheck" },
	{ job: 'quality', name: 'Check generated Zerops artifacts', run: 'bun run --filter @fabrika/platform-artifacts gen:check' },
]

export interface TestStep extends CiStep {
	/** The step's `if: matrix.shard == <n>` in `ci.yml`: it runs in that shard only. */
	readonly onlyInShard?: number
}

/** The `${{ matrix.shard }}` of a test step's `run`, replaced with each shard of `TEST_SHARDS`. */
export const SHARD_PLACEHOLDER = '${{ matrix.shard }}'

/** The test job's shard axis of the matrix; every shard runs against every PostgreSQL major. */
export const TEST_SHARDS: readonly number[] = [1, 2, 3, 4]

/** Run once per test job. `ci.yml`'s other test step, "Start SeaweedFS", is a backend this script starts. */
export const TEST_STEPS: readonly TestStep[] = [
	{ job: 'test', name: 'Run a shard of the main suite', run: `bun run test:unit --shard=${SHARD_PLACEHOLDER}/${TEST_SHARDS.length}` },
	{ job: 'test', name: 'Run the isolated suites', run: 'bun run test:isolated', onlyInShard: 1 },
]
export const S3_START_STEP_NAME = 'Start SeaweedFS'

export const BUILD_STEPS: readonly CiStep[] = [
	{ job: 'build', name: 'Build dashboard', run: 'bun run --filter @fabrika/dashboard build' },
	{ job: 'build', name: 'Build proxy', run: 'bun run --filter @fabrika/proxy build:check' },
]

/** These need npm on PATH, as the CI job gets it from `setup-node`. */
export const RELEASE_ARTIFACT_STEPS: readonly CiStep[] = [
	{ job: 'release-artifacts', name: 'Pack public packages', run: 'bun run release:pack --tag=v0.0.0-ci.0' },
	{ job: 'release-artifacts', name: 'Test tarballs in an isolated consumer', run: 'bun run release:smoke --tag=v0.0.0-ci.0' },
	{ job: 'release-artifacts', name: 'Verify npm publish inputs', run: 'bun run release:publish --tag=v0.0.0-ci.0 --dry-run' },
]

/** The test job's matrix: every PostgreSQL major the platform supports. */
export const POSTGRES_MAJORS: readonly string[] = ['17', '18']
export const postgresImage = (major: string): string => `postgres:${major}-alpine`
export const SEAWEEDFS_IMAGE = 'chrislusf/seaweedfs:4.42'

/** The test job's S3 values in `ci.yml`, less the endpoint, whose port is chosen per run here. */
export const S3_VALUES = {
	FABRIKA_TEST_S3_BUCKET: 'fabrika-test',
	FABRIKA_TEST_S3_ACCESS_KEY_ID: 'fabrika-test',
	FABRIKA_TEST_S3_SECRET_ACCESS_KEY: 'fabrika-test-secret',
	FABRIKA_TEST_S3_REGION: 'us-east-1',
}

const READINESS_ATTEMPTS = 60

/** One test job's backend: the environment values that name it, and the container this run started for it. */
interface Backend {
	readonly env: Record<string, string>
	/** Removed once its test job ends. */
	readonly container?: string
}

interface PostgresTarget {
	readonly label: string
	/** Opens one test job's database. `undefined`: the suites that need one skip. */
	readonly open: (() => Promise<Backend>) | undefined
}

interface TestBackends {
	readonly postgres: readonly PostgresTarget[]
	/** Opens one test job's S3. */
	readonly s3: () => Promise<Backend>
	/** Every job gets backends of its own, so the jobs may run at once; a given backend serves one job at a time. */
	readonly concurrent: boolean
}

interface TestJob {
	readonly label: string
	readonly shard: number
	readonly postgres: PostgresTarget
}

interface StepResult {
	readonly label: string
	readonly seconds: number
}

class StepFailure extends Error {}

const capture = async (command: readonly string[]): Promise<{ readonly exitCode: number; readonly stdout: string }> => {
	const child = Bun.spawn([...command], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
	const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
	return { exitCode, stdout }
}

const succeeds = async (command: readonly string[]): Promise<boolean> => (await capture(command)).exitCode === 0

const dockerAvailable = (): Promise<boolean> => succeeds(['docker', 'info', '--format', '{{.ServerVersion}}'])

/** The containers this run started, removed at the end whatever happened. */
const containers = new Set<string>()

const removeContainers = async (names: readonly string[]): Promise<void> => {
	for (const name of names) containers.delete(name)
	if (names.length > 0) await capture(['docker', 'rm', '--force', '--volumes', ...names])
}

const removeAllContainers = (): Promise<void> => removeContainers([...containers])

const startContainer = async (prefix: string, args: readonly string[]): Promise<string> => {
	const name = `${prefix}-${randomUUID().slice(0, 8)}`
	containers.add(name)
	const started = await capture(['docker', 'run', '--detach', '--name', name, ...args])
	if (started.exitCode !== 0) throw new StepFailure(`could not start the ${prefix} container`)
	return name
}

/** The loopback port docker chose for a container port published as `127.0.0.1::<port>`. */
const publishedPort = async (name: string, containerPort: number): Promise<string> => {
	const { stdout } = await capture(['docker', 'port', name, `${containerPort}/tcp`])
	const port = stdout.trim().split('\n')[0]?.split(':').at(-1)
	if (port === undefined || !/^\d+$/.test(port)) throw new StepFailure(`${name} publishes no port for ${containerPort}`)
	return port
}

const waitUntil = async (what: string, probe: readonly string[]): Promise<void> => {
	for (let attempt = 1; attempt <= READINESS_ATTEMPTS; attempt += 1) {
		if (await succeeds(probe)) return
		await Bun.sleep(1000)
	}
	throw new StepFailure(`${what} was not ready after ${READINESS_ATTEMPTS} s`)
}

const startPostgres = async (major: string): Promise<Backend> => {
	const name = await startContainer(`fabrika-check-ci-postgres-${major}`, [
		'--publish',
		'127.0.0.1::5432',
		'--env',
		'POSTGRES_PASSWORD=postgres',
		postgresImage(major),
	])
	// Over TCP: the entrypoint's temporary init server listens on the socket only, so it never answers this probe.
	await waitUntil(`PostgreSQL ${major}`, ['docker', 'exec', name, 'pg_isready', '--host=127.0.0.1', '--username=postgres'])
	return { env: { FABRIKA_TEST_POSTGRES_URL: `postgres://postgres:postgres@127.0.0.1:${await publishedPort(name, 5432)}/postgres` }, container: name }
}

const startSeaweedfs = async (): Promise<Backend> => {
	const name = await startContainer('fabrika-check-ci-s3', [
		'--publish',
		'127.0.0.1::9000',
		'--env',
		`AWS_ACCESS_KEY_ID=${S3_VALUES.FABRIKA_TEST_S3_ACCESS_KEY_ID}`,
		'--env',
		`AWS_SECRET_ACCESS_KEY=${S3_VALUES.FABRIKA_TEST_S3_SECRET_ACCESS_KEY}`,
		'--env',
		`S3_BUCKET=${S3_VALUES.FABRIKA_TEST_S3_BUCKET}`,
		SEAWEEDFS_IMAGE,
		'mini',
		'-dir=/data',
		'-s3.port=9000',
		'-s3.autoCreateBucket=false',
		'-master.telemetry=false',
	])
	await waitUntil('SeaweedFS', [
		'docker',
		'exec',
		name,
		'curl',
		'-fsS',
		'-o',
		'/dev/null',
		`http://127.0.0.1:8888/buckets/${S3_VALUES.FABRIKA_TEST_S3_BUCKET}/?limit=1`,
	])
	return { env: { ...S3_VALUES, FABRIKA_TEST_S3_ENDPOINT: `http://127.0.0.1:${await publishedPort(name, 9000)}` }, container: name }
}

const runStep = async (step: CiStep, label: string, env: Record<string, string | undefined>, results: StepResult[]): Promise<void> => {
	console.info(`\n▸ ${label}\n  $ ${step.run}`)
	const started = performance.now()
	const child = Bun.spawn(['bash', '-eo', 'pipefail', '-c', step.run], { cwd: ROOT, env, stdout: 'inherit', stderr: 'inherit' })
	const exitCode = await child.exited
	if (exitCode !== 0) throw new StepFailure(`"${label}" failed (exit ${exitCode})`)
	results.push({ label, seconds: (performance.now() - started) / 1000 })
}

const testBackends = (docker: boolean, skipped: string[]): TestBackends => {
	const givenPostgres = process.env['FABRIKA_TEST_POSTGRES_URL']
	const givenS3 = process.env['FABRIKA_TEST_S3_ENDPOINT']
	const postgresGiven = givenPostgres !== undefined && givenPostgres !== ''
	const s3Given = givenS3 !== undefined && givenS3 !== ''

	let postgres: readonly PostgresTarget[]
	if (postgresGiven) {
		skipped.push(`the PostgreSQL ${POSTGRES_MAJORS.join(' and ')} matrix: each shard ran once, against FABRIKA_TEST_POSTGRES_URL`)
		postgres = [{ label: 'FABRIKA_TEST_POSTGRES_URL', open: () => Promise.resolve({ env: {} }) }]
	} else if (docker) {
		postgres = POSTGRES_MAJORS.map((major) => ({ label: `PostgreSQL ${major}`, open: () => startPostgres(major) }))
	} else {
		skipped.push('every suite that needs PostgreSQL: docker is not available and FABRIKA_TEST_POSTGRES_URL is unset')
		postgres = [{ label: 'no PostgreSQL', open: undefined }]
	}

	if (!s3Given && !docker) skipped.push('every suite that needs S3: docker is not available and FABRIKA_TEST_S3_ENDPOINT is unset')
	const s3 = s3Given || !docker ? () => Promise.resolve({ env: {} }) : startSeaweedfs
	return { postgres, s3, concurrent: !postgresGiven && !s3Given }
}

/** Runs a step with its stdout and stderr captured together, so concurrent jobs do not interleave their output. */
const captureStep = async (run: string, env: Record<string, string | undefined>): Promise<{ readonly exitCode: number; readonly output: string }> => {
	const child = Bun.spawn(['bash', '-eo', 'pipefail', '-c', `exec 2>&1\n${run}`], { cwd: ROOT, env, stdout: 'pipe', stderr: 'inherit' })
	const [exitCode, output] = await Promise.all([child.exited, new Response(child.stdout).text()])
	return { exitCode, output }
}

/** Runs one job of the test matrix on backends of its own; false when a step failed, after printing its output. */
const runTestJob = async (
	job: TestJob,
	env: Record<string, string | undefined>,
	openS3: () => Promise<Backend>,
	results: StepResult[],
): Promise<boolean> => {
	const opened: Backend[] = []
	try {
		const database = job.postgres.open === undefined ? undefined : await job.postgres.open()
		if (database !== undefined) opened.push(database)
		const s3 = await openS3()
		opened.push(s3)
		const jobEnv = { ...env, ...s3.env, ...database?.env }
		for (const step of TEST_STEPS) {
			if (step.onlyInShard !== undefined && step.onlyInShard !== job.shard) continue
			const run = step.run.replaceAll(SHARD_PLACEHOLDER, String(job.shard))
			const label = `${job.label}: ${step.name}`
			console.info(`\n▸ ${label}\n  $ ${run}`)
			const started = performance.now()
			const { exitCode, output } = await captureStep(run, jobEnv)
			if (exitCode !== 0) {
				console.error(`\n✗ ${label} failed (exit ${exitCode}):\n${output}`)
				return false
			}
			const seconds = (performance.now() - started) / 1000
			results.push({ label, seconds })
			console.info(`✓ ${label} (${seconds.toFixed(1)} s)`)
		}
		return true
	} finally {
		await removeContainers(opened.flatMap((backend) => backend.container === undefined ? [] : [backend.container]))
	}
}

const runTestMatrix = async (env: Record<string, string | undefined>, backends: TestBackends, results: StepResult[]): Promise<void> => {
	const jobs = backends.postgres.flatMap((postgres) =>
		TEST_SHARDS.map((shard) => ({ label: `test (${postgres.label}, shard ${shard}/${TEST_SHARDS.length})`, shard, postgres }))
	)
	const runJob = (job: TestJob): Promise<boolean> => runTestJob(job, env, backends.s3, results)
	if (!backends.concurrent) {
		for (const job of jobs) if (!await runJob(job)) throw new StepFailure(`${job.label} failed`)
		return
	}
	// Settle every job before throwing, so no job is still running when the containers are removed.
	const settled = await Promise.allSettled(jobs.map(runJob))
	const failed = jobs.flatMap((job, index) => {
		const outcome = settled[index]
		if (outcome?.status === 'rejected') return [`${job.label} (${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)})`]
		return outcome?.value === false ? [job.label] : []
	})
	if (failed.length > 0) throw new StepFailure(`${failed.join(', ')} failed`)
}

const run = async (results: StepResult[], skipped: string[]): Promise<void> => {
	const env = { ...process.env }
	await runStep(INSTALL_STEP, `quality: ${INSTALL_STEP.name}`, env, results)
	for (const step of QUALITY_STEPS) await runStep(step, `${step.job}: ${step.name}`, env, results)

	await runTestMatrix(env, testBackends(await dockerAvailable(), skipped), results)

	for (const step of BUILD_STEPS) await runStep(step, `${step.job}: ${step.name}`, env, results)

	if (Bun.which('npm') === null) {
		skipped.push(`the release-artifacts job (${RELEASE_ARTIFACT_STEPS.map((step) => step.name).join(', ')}): npm is not on PATH`)
		return
	}
	for (const step of RELEASE_ARTIFACT_STEPS) await runStep(step, `${step.job}: ${step.name}`, env, results)
}

const printSummary = (results: readonly StepResult[], skipped: readonly string[], totalSeconds: number): void => {
	console.info('\ncheck:ci summary')
	for (const result of results) console.info(`  ${result.seconds.toFixed(1).padStart(7)} s  ${result.label}`)
	console.info(`  ${totalSeconds.toFixed(1).padStart(7)} s  total`)
	if (skipped.length === 0) {
		console.info('Nothing was skipped.')
		return
	}
	console.warn('SKIPPED — CI runs these and this run did not:')
	for (const line of skipped) console.warn(`  - ${line}`)
}

const main = async (): Promise<void> => {
	const results: StepResult[] = []
	const skipped: string[] = []
	const started = performance.now()
	const interrupt = (): void => {
		void removeAllContainers().finally(() => process.exit(130))
	}
	process.on('SIGINT', interrupt)
	process.on('SIGTERM', interrupt)
	try {
		await run(results, skipped)
	} catch (error) {
		await removeAllContainers()
		printSummary(results, skipped, (performance.now() - started) / 1000)
		console.error(`\ncheck:ci failed: ${error instanceof StepFailure ? error.message : String(error)}`)
		process.exit(1)
	}
	printSummary(results, skipped, (performance.now() - started) / 1000)
}

if (import.meta.main) await main()
