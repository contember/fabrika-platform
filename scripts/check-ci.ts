// `bun run check:ci` runs every step of `.github/workflows/ci.yml` locally, CI's jobs at once, so a green run here is a green
// CI run; docs/reference/release-process.md ("The same gates locally") says in what order and why.
// `scripts/__tests__/check-ci.test.ts` fails when these steps and `ci.yml` drift apart.

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
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

/** Each main-suite file's measured duration, which `bun test --timings` splits the shards by; `bun run test:timings` rewrites it. */
export const TEST_TIMINGS_FILE = 'test-timings.json'

/**
 * Run once per test job. `ci.yml`'s other test steps are backends this script starts: "Start SeaweedFS", and the
 * Postgres settings step, which this script passes to its Postgres as `-c` flags instead.
 * The isolated suites (`test:isolated`) are spread over the shards by their measured time, the longest on its own.
 */
export const TEST_STEPS: readonly TestStep[] = [
	{
		job: 'test',
		name: 'Run a shard of the main suite',
		run: `bun run test:unit --shard=${SHARD_PLACEHOLDER}/${TEST_SHARDS.length} --timings=${TEST_TIMINGS_FILE}`,
	},
	{ job: 'test', name: 'Run the builder suite', run: 'bun run test:builder', onlyInShard: 1 },
	{ job: 'test', name: 'Run the Lopata suites', run: 'bun run test:lopata', onlyInShard: 2 },
	{ job: 'test', name: 'Run the agent-interface and DOM suites', run: 'bun run test:agent-interfaces && bun run test:dom', onlyInShard: 3 },
	{ job: 'test', name: 'Run the example suites', run: 'bun run test:examples', onlyInShard: 4 },
]
export const S3_START_STEP_NAME = 'Start SeaweedFS'
export const POSTGRES_SETTINGS_STEP_NAME = 'Run the test Postgres without durability'

/** A test database needs no durability: a relation drop's WAL flush stalled DDL-heavy suites past their timeout. */
export const POSTGRES_TEST_SETTINGS: Readonly<Record<string, string>> = { fsync: 'off', full_page_writes: 'off', synchronous_commit: 'off' }

export const BUILD_STEPS: readonly CiStep[] = [
	{ job: 'build', name: 'Build dashboard', run: 'bun run --filter @fabrika/dashboard build' },
	{ job: 'build', name: 'Build proxy', run: 'bun run --filter @fabrika/proxy build:check' },
]

/**
 * These need docker, each built from the committed tree (`git archive HEAD`): the namespace proxy's image, started
 * once, and the AWS platform services' image, checked for what it holds.
 */
export const PROXY_IMAGE_STEPS: readonly CiStep[] = [
	{ job: 'proxy-image', name: 'Build and start the proxy image', run: 'bun run --filter @fabrika/provider-aws proxy-image:check' },
	{
		job: 'platform-image',
		name: "Build the platform services' image and check what it holds",
		run: 'bun run --filter @fabrika/provider-aws platform-image:check',
	},
]

/** These need npm on PATH, as the CI job gets it from `setup-node`. The pack reads the working tree, the others its tarballs. */
export const RELEASE_PACK_STEP: CiStep = { job: 'release-artifacts', name: 'Pack public packages', run: 'bun run release:pack --tag=v0.0.0-ci.0' }
export const RELEASE_CHECK_STEPS: readonly CiStep[] = [
	{ job: 'release-artifacts', name: 'Test tarballs in an isolated consumer', run: 'bun run release:smoke --tag=v0.0.0-ci.0' },
	{ job: 'release-artifacts', name: 'Verify npm publish inputs', run: 'bun run release:publish --tag=v0.0.0-ci.0 --dry-run' },
]
export const RELEASE_ARTIFACT_STEPS: readonly CiStep[] = [RELEASE_PACK_STEP, ...RELEASE_CHECK_STEPS]

/** The test job's PostgreSQL majors in the gate: the one Zerops runs. `ci.yml`'s nightly run adds 17, which this script does not run. */
export const POSTGRES_MAJORS: readonly string[] = ['18']

/** The test job's PostgreSQL majors in `ci.yml`'s nightly run: every major the platform supports. */
export const NIGHTLY_POSTGRES_MAJORS: readonly string[] = ['17', '18']
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
export interface Backend {
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

const capture = async (command: readonly string[]): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
	const child = Bun.spawn([...command], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
	const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
	return { exitCode, stdout, stderr }
}

const succeeds = async (command: readonly string[]): Promise<boolean> => (await capture(command)).exitCode === 0

const dockerAvailable = (): Promise<boolean> => succeeds(['docker', 'info', '--format', '{{.ServerVersion}}'])

/** The containers this run started, removed at the end whatever happened. */
const containers = new Set<string>()

export const removeContainers = async (names: readonly string[]): Promise<void> => {
	for (const name of names) containers.delete(name)
	if (names.length > 0) await capture(['docker', 'rm', '--force', '--volumes', ...names])
}

export const removeAllContainers = (): Promise<void> => removeContainers([...containers])

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

/** A loopback port no socket holds right now, picked by the OS. */
const freeLoopbackPort = (): number => {
	const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => {} } })
	const { port } = listener
	listener.stop(true)
	return port
}

/** Another process may bind the free port before PostgreSQL does; the server then exits and a new port is tried. */
const POSTGRES_PORT_ATTEMPTS = 3

/** Only when docker reports it stopped: a failed inspect (an interrupted run) says nothing about the container. */
const containerExited = async (name: string): Promise<boolean> => {
	const { exitCode, stdout } = await capture(['docker', 'inspect', '--format', '{{.State.Running}}', name])
	return exitCode === 0 && stdout.trim() === 'false'
}

/** PostgreSQL logs to stderr, which `docker logs` replays on its own stderr. */
const containerLogs = async (name: string, tail: string): Promise<string> => {
	const { stdout, stderr } = await capture(['docker', 'logs', '--tail', tail, name])
	return stdout + stderr
}

/** True once this container's server answers on the port, false when the container exited first. */
const postgresReady = async (name: string, major: string, port: number): Promise<boolean> => {
	// On the host network another server may hold the port; only the container's own log proves its server bound it.
	const listening = `listening on IPv4 address "127.0.0.1", port ${port}`
	for (let attempt = 1; attempt <= READINESS_ATTEMPTS; attempt += 1) {
		if (
			(await containerLogs(name, 'all')).includes(listening)
			// Over TCP: the entrypoint's temporary init server listens on the socket only, so it never answers this probe.
			&& await succeeds(['docker', 'exec', name, 'pg_isready', '--host=127.0.0.1', `--port=${port}`, '--username=postgres'])
		) return true
		if (await containerExited(name)) return false
		await Bun.sleep(1000)
	}
	throw new StepFailure(`PostgreSQL ${major} was not ready after ${READINESS_ATTEMPTS} s`)
}

/** PostgreSQL 18 moved its data directory under `/var/lib/postgresql`; earlier majors keep it in `data/` below. */
const postgresDataDir = (major: string): string => Number(major) >= 18 ? '/var/lib/postgresql' : '/var/lib/postgresql/data'

/** On the host network, so a run creates no bridge interface for it; it listens on loopback only, its data on tmpfs. */
export const startPostgres = async (major: string): Promise<Backend> => {
	for (let attempt = 1; attempt <= POSTGRES_PORT_ATTEMPTS; attempt += 1) {
		const port = freeLoopbackPort()
		const name = await startContainer(`fabrika-check-ci-postgres-${major}`, [
			'--network',
			'host',
			'--tmpfs',
			postgresDataDir(major),
			'--env',
			`PGPORT=${port}`,
			'--env',
			'POSTGRES_PASSWORD=postgres',
			// initdb trusts loopback TCP by default; over the bridge, as in CI, a client came from the gateway and needed its password.
			'--env',
			'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256',
			postgresImage(major),
			'postgres',
			'-c',
			'listen_addresses=127.0.0.1',
			...Object.entries(POSTGRES_TEST_SETTINGS).flatMap(([name, value]) => ['-c', `${name}=${value}`]),
		])
		if (await postgresReady(name, major, port)) {
			return { env: { FABRIKA_TEST_POSTGRES_URL: `postgres://postgres:postgres@127.0.0.1:${port}/postgres` }, container: name }
		}
		console.warn(`PostgreSQL ${major} exited before it was ready on port ${port}:\n${await containerLogs(name, '20')}`)
		await removeContainers([name])
	}
	throw new StepFailure(`PostgreSQL ${major} exited before it was ready, ${POSTGRES_PORT_ATTEMPTS} times; its log is printed above`)
}

export const startSeaweedfs = async (): Promise<Backend> => {
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

/** The install streams its output: it runs alone, before every lane. */
const runInstall = async (env: Record<string, string | undefined>, results: StepResult[]): Promise<void> => {
	const label = `${INSTALL_STEP.job}: ${INSTALL_STEP.name}`
	console.info(`\n▸ ${label}\n  $ ${INSTALL_STEP.run}`)
	const started = performance.now()
	const child = Bun.spawn(['bash', '-eo', 'pipefail', '-c', INSTALL_STEP.run], { cwd: ROOT, env, stdout: 'inherit', stderr: 'inherit' })
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

/**
 * The lanes beside the test matrix run below its priority: its suites have 5 s timeouts, and a typecheck or a build
 * competing at the same priority pushed them past those. The lanes take what CPU the tests leave.
 */
const BACKGROUND_NICENESS = '10'

/** Runs a step with its stdout and stderr captured together, so concurrent jobs do not interleave their output. */
const captureStep = async (
	run: string,
	env: Record<string, string | undefined>,
	priority: 'tests' | 'background',
): Promise<{ readonly exitCode: number; readonly output: string }> => {
	const shell = ['bash', '-eo', 'pipefail', '-c', `exec 2>&1\n${run}`]
	const command = priority === 'tests' ? shell : ['nice', '-n', BACKGROUND_NICENESS, ...shell]
	const child = Bun.spawn(command, { cwd: ROOT, env, stdout: 'pipe', stderr: 'inherit' })
	const [exitCode, output] = await Promise.all([child.exited, new Response(child.stdout).text()])
	return { exitCode, output }
}

/** Runs one step with its output captured; false when it failed, after printing its output. */
const runCaptured = async (
	run: string,
	label: string,
	env: Record<string, string | undefined>,
	priority: 'tests' | 'background',
	results: StepResult[],
): Promise<boolean> => {
	console.info(`▸ ${label}\n  $ ${run}`)
	const started = performance.now()
	const { exitCode, output } = await captureStep(run, env, priority)
	if (exitCode !== 0) {
		console.error(`\n✗ ${label} failed (exit ${exitCode}):\n${output}`)
		return false
	}
	const seconds = (performance.now() - started) / 1000
	results.push({ label, seconds })
	console.info(`✓ ${label} (${seconds.toFixed(1)} s)`)
	return true
}

/** A lane: CI jobs' steps in order, stopping at the first that fails, as one CI job does. */
const runLane = async (steps: readonly CiStep[], env: Record<string, string | undefined>, results: StepResult[]): Promise<void> => {
	for (const step of steps) {
		const label = `${step.job}: ${step.name}`
		if (!await runCaptured(step.run, label, env, 'background', results)) throw new StepFailure(`"${label}" failed`)
	}
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
			if (!await runCaptured(run, `${job.label}: ${step.name}`, jobEnv, 'tests', results)) return false
		}
		return true
	} finally {
		await removeContainers(opened.flatMap((backend) => backend.container === undefined ? [] : [backend.container]))
	}
}

/**
 * The physical cores among the CPUs this process may run on: SMT siblings share one core, so they count once. Undefined
 * where Linux's `/proc` and `/sys` do not say.
 */
export const availableCores = (): number | undefined => {
	try {
		const allowed = /^Cpus_allowed_list:\s*([\d,-]+)$/m.exec(readFileSync('/proc/self/status', 'utf8'))?.[1]
		if (allowed === undefined) return undefined
		const cores = new Set<string>()
		for (const range of allowed.split(',')) {
			const bounds = /^(\d+)(?:-(\d+))?$/.exec(range)
			if (bounds?.[1] === undefined) return undefined
			const first = Number(bounds[1])
			const last = bounds[2] === undefined ? first : Number(bounds[2])
			for (let cpu = first; cpu <= last; cpu += 1) {
				cores.add(readFileSync(`/sys/devices/system/cpu/cpu${cpu}/topology/thread_siblings_list`, 'utf8').trim())
			}
		}
		return cores.size
	} catch {
		return undefined
	}
}

/**
 * One test job per core the run may use: on 4 vCPU (2 cores), 4 jobs at once pushed tests past their 5 s timeouts. Without
 * a topology to read, a core is taken to be two CPUs.
 */
export const testJobWorkers = (jobs: number): number => Math.max(1, Math.min(availableCores() ?? Math.floor(availableParallelism() / 2), jobs))

const runTestMatrix = async (env: Record<string, string | undefined>, backends: TestBackends, results: StepResult[]): Promise<void> => {
	const jobs = backends.postgres.flatMap((postgres) =>
		TEST_SHARDS.map((shard) => ({ label: `test (${postgres.label}, shard ${shard}/${TEST_SHARDS.length})`, shard, postgres }))
	)
	const runJob = (job: TestJob): Promise<boolean> => runTestJob(job, env, backends.s3, results)
	if (!backends.concurrent) {
		for (const job of jobs) if (!await runJob(job)) throw new StepFailure(`${job.label} failed`)
		return
	}
	// A worker never throws, so every job has ended before the containers are removed.
	const failed: string[] = []
	let next = 0
	const worker = async (): Promise<void> => {
		for (let job = jobs[next++]; job !== undefined; job = jobs[next++]) {
			try {
				if (!await runJob(job)) failed.push(job.label)
			} catch (error) {
				failed.push(`${job.label} (${error instanceof Error ? error.message : String(error)})`)
			}
		}
	}
	await Promise.all(Array.from({ length: testJobWorkers(jobs.length) }, worker))
	if (failed.length > 0) throw new StepFailure(`${failed.join(', ')} failed`)
}

const run = async (results: StepResult[], skipped: string[]): Promise<void> => {
	const env = { ...process.env }
	await runInstall(env, results)
	const docker = await dockerAvailable()
	const npm = Bun.which('npm') !== null

	// Each image is built from `git archive HEAD`, so it reads nothing the other jobs write; each is a job of its own.
	const lanes: Promise<void>[] = docker ? PROXY_IMAGE_STEPS.map((step) => runLane([step], env, results)) : []
	if (!docker) skipped.push(`the image jobs (${PROXY_IMAGE_STEPS.map((step) => step.name).join(', ')}): docker is not available`)
	if (!npm) skipped.push(`the release-artifacts job (${RELEASE_ARTIFACT_STEPS.map((step) => step.name).join(', ')}): npm is not on PATH`)

	// Suites write scratch files into the source tree, which the quality steps and the pack walk; these end before tests start.
	const quality = runLane(QUALITY_STEPS, env, results)
	const pack = npm ? runLane([RELEASE_PACK_STEP], env, results) : undefined
	await Promise.allSettled(pack === undefined ? [quality] : [quality, pack])

	// The builds also follow the quality steps: the typecheck and the dashboard's build both rewrite its generated routes.
	lanes.push(quality, runTestMatrix(env, testBackends(docker, skipped), results), runLane(BUILD_STEPS, env, results))
	if (pack !== undefined) lanes.push(pack.then(() => runLane(RELEASE_CHECK_STEPS, env, results)))

	// Every lane runs to its end, as CI's jobs do, so one run names every failure.
	const failures = (await Promise.allSettled(lanes)).flatMap((lane) =>
		lane.status === 'fulfilled' ? [] : [lane.reason instanceof Error ? lane.reason.message : String(lane.reason)]
	)
	if (failures.length > 0) throw new StepFailure(failures.join('; '))
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
