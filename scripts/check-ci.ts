// `bun run check:ci` runs locally what `.github/workflows/ci.yml` runs, in the same order, so a green run here is a
// green CI run. `release.yml` calls that workflow as its `verify` job, so this is also the gate a tag must pass.
//
// The test job's backends are throwaway containers on random loopback ports, one PostgreSQL per major of the CI
// matrix and one SeaweedFS, removed at the end. A backend the environment already names is used as it is. What cannot
// run here — no docker, no npm — is skipped and named in the summary, never silently.
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
	{ job: 'quality', name: 'Check generated Zerops artifacts', run: 'bun run --filter @fabrika/platform-artifacts gen:check' },
]

/** Runs once per PostgreSQL target. `ci.yml`'s other test step, "Start SeaweedFS", is the backend this script starts. */
export const TEST_STEP: CiStep = { job: 'test', name: 'Run full test suite', run: 'bun run test' }
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

interface PostgresDatabase {
	readonly url: string
	/** The container this run started for it, removed once its test run ends. */
	readonly container?: string
}

interface PostgresTarget {
	readonly label: string
	/** Started on first use, so only one database runs at a time. `undefined`: the suites that need one skip. */
	readonly open: (() => Promise<PostgresDatabase>) | undefined
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

const startPostgres = async (major: string): Promise<PostgresDatabase> => {
	const name = await startContainer(`fabrika-check-ci-postgres-${major}`, [
		'--publish',
		'127.0.0.1::5432',
		'--env',
		'POSTGRES_PASSWORD=postgres',
		postgresImage(major),
	])
	// Over TCP: the entrypoint's temporary init server listens on the socket only, so it never answers this probe.
	await waitUntil(`PostgreSQL ${major}`, ['docker', 'exec', name, 'pg_isready', '--host=127.0.0.1', '--username=postgres'])
	return { url: `postgres://postgres:postgres@127.0.0.1:${await publishedPort(name, 5432)}/postgres`, container: name }
}

const startSeaweedfs = async (): Promise<Record<string, string>> => {
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
	return { ...S3_VALUES, FABRIKA_TEST_S3_ENDPOINT: `http://127.0.0.1:${await publishedPort(name, 9000)}` }
}

const runStep = async (step: CiStep, label: string, env: Record<string, string | undefined>, results: StepResult[]): Promise<void> => {
	console.info(`\n▸ ${label}\n  $ ${step.run}`)
	const started = performance.now()
	const child = Bun.spawn(['bash', '-eo', 'pipefail', '-c', step.run], { cwd: ROOT, env, stdout: 'inherit', stderr: 'inherit' })
	const exitCode = await child.exited
	if (exitCode !== 0) throw new StepFailure(`"${label}" failed (exit ${exitCode})`)
	results.push({ label, seconds: (performance.now() - started) / 1000 })
}

const postgresTargets = (docker: boolean, skipped: string[]): readonly PostgresTarget[] => {
	const given = process.env['FABRIKA_TEST_POSTGRES_URL']
	if (given !== undefined && given !== '') {
		skipped.push(`the PostgreSQL ${POSTGRES_MAJORS.join(' and ')} matrix: the suite ran once, against FABRIKA_TEST_POSTGRES_URL`)
		return [{ label: 'FABRIKA_TEST_POSTGRES_URL', open: () => Promise.resolve({ url: given }) }]
	}
	if (!docker) {
		skipped.push('every suite that needs PostgreSQL: docker is not available and FABRIKA_TEST_POSTGRES_URL is unset')
		return [{ label: 'no PostgreSQL', open: undefined }]
	}
	return POSTGRES_MAJORS.map((major) => ({ label: `PostgreSQL ${major}`, open: () => startPostgres(major) }))
}

const s3Environment = async (docker: boolean, skipped: string[]): Promise<Record<string, string>> => {
	const given = process.env['FABRIKA_TEST_S3_ENDPOINT']
	if (given !== undefined && given !== '') return {}
	if (!docker) {
		skipped.push('every suite that needs S3: docker is not available and FABRIKA_TEST_S3_ENDPOINT is unset')
		return {}
	}
	return await startSeaweedfs()
}

const run = async (results: StepResult[], skipped: string[]): Promise<void> => {
	const env = { ...process.env }
	await runStep(INSTALL_STEP, `quality: ${INSTALL_STEP.name}`, env, results)
	for (const step of QUALITY_STEPS) await runStep(step, `${step.job}: ${step.name}`, env, results)

	const docker = await dockerAvailable()
	const s3 = await s3Environment(docker, skipped)
	for (const target of postgresTargets(docker, skipped)) {
		const database = target.open === undefined ? undefined : await target.open()
		const testEnv = database === undefined ? { ...env, ...s3 } : { ...env, ...s3, FABRIKA_TEST_POSTGRES_URL: database.url }
		await runStep(TEST_STEP, `test (${target.label}): ${TEST_STEP.name}`, testEnv, results)
		if (database?.container !== undefined) await removeContainers([database.container])
	}
	await removeAllContainers()

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
