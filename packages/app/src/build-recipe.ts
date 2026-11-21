// The build, init and start of a contract application in a Bun container, as data (ADR-0043): the steps and their
// order are the platform's, never the repository's. A provider renders the recipe into its own build form, with its own
// paths, file writes and scheduler. PURE — no network, no filesystem.
//
// PLATFORM PROTOCOL, not framework API: the platform renders this with ITS copy for applications of older releases
// (ADR-0062), so the commands, script names and job names an application must accept change only additively. Never
// render the application's own copy.

import { APPLICATION_SERVER_MAX_HEADER_BYTES, FRAMEWORK_RELEASE_PATTERN, releaseAtLeast } from '@fabrika/auth-core'
import { CONTRACT_APP_ID_PATTERN } from './contract/app-id.js'
import { FILE_SCAN_JOB, FILE_SCAN_SCHEDULE, FILE_SWEEP_JOB, FILE_SWEEP_SCHEDULE } from './files/job-names.js'

export { CONTRACT_APP_ID_PATTERN } from './contract/app-id.js'

export { FILE_SCAN_JOB, FILE_SWEEP_JOB } from './files/job-names.js'

/** The TypeScript release of the platform's type check; the application's own `typescript` is not run. */
export const PLATFORM_TYPESCRIPT_VERSION = '5.9.3'

/** The CLI a generated script runs, relative to the application root. */
const FABRIKA_BIN = './node_modules/.bin/fabrika'
const MIGRATE_SCRIPT = 'fabrika/migrate.generated.sh'
const VERIFY_SCRIPT = 'fabrika/verify.generated.sh'
const START_SCRIPT = 'fabrika/start.generated.sh'
const SERVE: readonly string[] = ['bun', `--max-http-header-size=${APPLICATION_SERVER_MAX_HEADER_BYTES}`, 'fabrika/entry.generated.ts']
const MIGRATE: readonly string[] = [FABRIKA_BIN, 'db', 'migrate']
const PLATFORM_TSCONFIG = 'fabrika/tsconfig.platform.json'

/** The application CLI's arguments that fail when the committed schema types are stale, run from the application root. */
export const SCHEMA_TYPES_CHECK: readonly string[] = ['db', 'codegen', '--verify']

/** The Alpine package of the throwaway PostgreSQL: the major of the platform's application databases (`postgresql:*@18`). */
const BUILD_POSTGRES_PACKAGE = 'postgresql18'
/** The throwaway cluster's directory, outside the source root, so nothing of it is deployed. */
const BUILD_POSTGRES_DIR = '/tmp/fabrika-build-postgres'

/**
 * The first framework minor whose build type-checks the SPA under `web/`; an older application never had it checked.
 * Read from `checkRelease`: Control picks the reader by the pin's minor, so the two always share it.
 */
const SPA_TYPE_CHECK_SINCE = { major: 0, minor: 9 }

/**
 * The compiler options of the platform's type check; the application's own `tsconfig.json` and its `paths` are not read.
 * From 0.9 it covers the SPA under `web/` too, since Bun bundles the SPA without checking its types. An older release
 * keeps 0.8's `src/` check, so a platform upgrade fails no build that passed before (ADR-0062).
 */
const platformTsconfigContents = (checkRelease: string): string =>
	JSON.stringify({
		compilerOptions: {
			target: 'ES2022',
			module: 'ESNext',
			moduleResolution: 'bundler',
			lib: ['ES2022', 'DOM', 'DOM.Iterable'],
			jsx: 'react-jsx',
			types: ['bun'],
			strict: true,
			noUncheckedIndexedAccess: true,
			noImplicitOverride: true,
			forceConsistentCasingInFileNames: true,
			skipLibCheck: true,
			resolveJsonModule: true,
			isolatedModules: true,
			noEmit: true,
		},
		include: releaseAtLeast(checkRelease, SPA_TYPE_CHECK_SINCE)
			? ['../fabrika.contract.ts', '../src', '../web', 'entry.generated.ts']
			: ['../fabrika.contract.ts', '../src', 'entry.generated.ts'],
	})

const INSTALL = 'bun install --frozen-lockfile --ignore-scripts'

/**
 * What `@fabrika/db/testing` prints after the label of a test file it skips without `FABRIKA_TEST_POSTGRES_URL`. Every
 * framework release prints it, so the platform counts it for any application's release.
 */
const DATABASE_TEST_SKIP_MARKER = ' skipped: set FABRIKA_TEST_POSTGRES_URL to run the Postgres-backed tests'

/** The prefix of the line the tests command prints after the test run. */
const TESTS_REPORT_PREFIX = 'fabrika-tests:'

/** One `bun -e "…"` running `script`, which may hold none of the characters a double-quoted shell word expands. */
const bunEvalCommand = (script: readonly string[]): string => {
	const source = script.join(' ')
	if (/["$`\\!]/.test(source)) throw new Error('a generated bun -e script must not contain a quote, an expansion or a backslash')
	return `bun -e "${source}"`
}

/**
 * The first framework minor whose build runs the application's own `test` script of `package.json` when it has one; an
 * older application keeps `bun test --isolate --pass-with-no-tests`, so a platform upgrade changes no build of it.
 */
const OWN_TEST_SCRIPT_SINCE = { major: 0, minor: 9 }

const DEFAULT_TESTS = "[process.execPath, 'test', '--isolate', '--pass-with-no-tests']"

// The tests run before any database, so every Postgres-backed test file skips and the run still passes. This command runs the
// tests and then says how many files did not run, so a green test step does not read as a tested database.
const testsCommand = (ownScript: boolean): string =>
	bunEvalCommand([
		...(ownScript
			? [
				"const manifest = Bun.file('package.json');",
				'const scripts = (await manifest.exists()) ? (await manifest.json()).scripts : undefined;',
				"const own = typeof scripts?.test === 'string' && scripts.test.trim().length > 0;",
				`console.warn('${TESTS_REPORT_PREFIX} ' + (own ? 'runs the test script of package.json' : 'runs bun test --isolate --pass-with-no-tests'));`,
				`const child = Bun.spawn(own ? [process.execPath, 'run', 'test'] : ${DEFAULT_TESTS}, { stdout: 'pipe', stderr: 'pipe' });`,
				// A script may send its stderr to stdout, so both streams are read, each whole, for the skip lines.
				"const read = async (stream, sink) => { const decoder = new TextDecoder(); let text = ''; for await (const chunk of stream) { sink.write(chunk); text += decoder.decode(chunk, { stream: true }) } return text };",
				'const output = (await Promise.all([read(child.stdout, process.stdout), read(child.stderr, process.stderr)])).join(String.fromCharCode(10));',
			]
			: [
				`const child = Bun.spawn(${DEFAULT_TESTS}, { stdout: 'inherit', stderr: 'pipe' });`,
				'const decoder = new TextDecoder();',
				"let output = '';",
				'for await (const chunk of child.stderr) { process.stderr.write(chunk); output += decoder.decode(chunk, { stream: true }) }',
			]),
		'const code = await child.exited;',
		`const marker = '${DATABASE_TEST_SKIP_MARKER}';`,
		'const skipped = output.split(String.fromCharCode(10)).filter((line) => line.includes(marker)).map((line) => line.slice(0, line.indexOf(marker)).trim());',
		`const prefix = '${TESTS_REPORT_PREFIX}';`,
		"console.warn(skipped.length === 0 ? prefix + ' no Postgres-backed test file skipped' : prefix + ' ' + skipped.length + ' Postgres-backed test files did not run, because the build has no database: ' + skipped.join(', '));",
		'process.exit(code);',
	])

/** A `c.cron` job name, which a crontab line carries unquoted. */
export const CONTRACT_JOB_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/
/** Five cron fields of digits and `*`, `/`, `,`, `-` only. */
export const CRON_SCHEDULE_PATTERN = /^[0-9*/,-]+(?: [0-9*/,-]+){4}$/

/** What one contract application's recipe depends on. `contractRecipe` refuses a value that a shell would read as more. */
export interface ContractRecipeInput {
	readonly appId: string
	/** The `@fabrika/check` release whose reader read the application (ADR-0062). */
	readonly checkRelease: string
	/** The absolute directory the build runs in: the checker reads the source there. */
	readonly sourceRoot: string
	/** The absolute directory the built application runs from: each generated script starts there. */
	readonly runtimeRoot: string
	/**
	 * Without a database, `false`. With one, every container migrates before the server starts, and the schema check
	 * runs where `schemaChecks` says: `build` on a throwaway PostgreSQL the build installs with `sudo apk` (an Alpine build
	 * image), `init` at every container start, after the migrations.
	 */
	readonly database: false | { readonly schemaChecks: 'build' | 'init' }
	/** Whether the build uploads its source maps, last and never failing the build. */
	readonly sourceMaps: boolean
	readonly jobs: readonly { readonly name: string; readonly schedule: string }[]
	/** The contract declares a file collection: the sweep of removed files is scheduled. */
	readonly files: boolean
	/** A file collection scans its uploads: the scan pass is scheduled. */
	readonly scan: boolean
}

/** One build step: a command run in the source root, or a generated file written there, line by line. */
export type ContractBuildStep = { readonly run: string } | { readonly write: string; readonly lines: readonly string[] }

/** One check of the build: a command run in the source root that fails the build. */
export interface ContractCheck {
	readonly name: 'tests' | 'tsc' | 'fabrika-check'
	readonly command: string
}

/** The checks of a build, and the platform tsconfig its `tsc` check reads, which the build writes into the source root first. */
export interface ContractChecks {
	readonly tsconfig: { readonly write: string; readonly lines: readonly string[] }
	/** In the order a build runs them. */
	readonly checks: readonly [tests: ContractCheck, tsc: ContractCheck, check: ContractCheck]
}

/** An absolute path of characters no shell reads as more than one word. */
const SOURCE_ROOT_PATTERN = /^\/[A-Za-z0-9._@+/-]*$/

/**
 * The checks of an application whose source is at `sourceRoot` (absolute), with `@fabrika/check` at `checkRelease`. Each
 * command runs in the source root. `tsc` and the checker run from `/tmp`, so neither resolves the application's own copy.
 */
export function contractChecks(sourceRoot: string, checkRelease: string): ContractChecks {
	if (!SOURCE_ROOT_PATTERN.test(sourceRoot)) throw new Error('the source root must be an absolute path a shell reads as one word')
	if (!FRAMEWORK_RELEASE_PATTERN.test(checkRelease)) throw new Error('the checker release must be a release version')
	return {
		tsconfig: { write: PLATFORM_TSCONFIG, lines: [platformTsconfigContents(checkRelease)] },
		checks: [
			{ name: 'tests', command: testsCommand(releaseAtLeast(checkRelease, OWN_TEST_SCRIPT_SINCE)) },
			{ name: 'tsc', command: `cd /tmp && bun x --bun -p typescript@${PLATFORM_TYPESCRIPT_VERSION} tsc -p ${sourceRoot}/${PLATFORM_TSCONFIG}` },
			{ name: 'fabrika-check', command: `cd /tmp && bun x --bun -p @fabrika/check@${checkRelease} fabrika-check ${sourceRoot}` },
		],
	}
}

export interface ContractRecipe {
	/** The steps after the authored SPA commands, in order. */
	readonly build: readonly ContractBuildStep[]
	/** The checks among `build`, in its order. */
	readonly checks: readonly ContractCheck[]
	/** The generated scripts every container runs before `start`, in order; any failure stops the activation. */
	readonly init: readonly string[]
	/** The generated script that starts the server, which only `exec`s it. */
	readonly start: string
	/** The command the start script `exec`s, run from the runtime root. */
	readonly serve: readonly string[]
	/** The command that migrates the application's database, run from the runtime root. */
	readonly migrate: readonly string[]
	/** The jobs to schedule, each on one container; a command runs from the runtime root. */
	readonly jobs: readonly { readonly schedule: string; readonly command: string }[]
}

/**
 * The schema check leaves container start only because the application's `fabrika db migrate` checks the live schema's
 * code on every run, which the provider reads from the `@fabrika/app` pin. The `fabrika` binary is `@fabrika/cli`'s,
 * pinned on its own, so a build whose CLI is older than its framework fails here rather than lose that check unseen.
 */
const CLI_RELEASE_CHECK = 'bun -e "'
	+ "const release = async (name) => (await Bun.file('node_modules/' + name + '/package.json').json()).version; "
	+ "const [cli, app] = await Promise.all([release('@fabrika/cli'), release('@fabrika/app')]); "
	+ 'if (Bun.semver.order(cli, app) < 0) { '
	+ "console.error('fabrika: the build check failed: @fabrika/cli ' + cli + ' is older than @fabrika/app ' + app "
	+ "+ '; pin every @fabrika package to one release'); process.exit(1) }"
	+ '"'

/**
 * One build command that migrates a throwaway PostgreSQL from scratch with the application's migrations, runs the schema
 * check on it and stops it. It is one command because each build command runs in its own shell. The cluster listens on
 * a unix socket in a private directory only, behind a random password. A failed step names itself. The cleanup is armed
 * before the password is written and stays armed to the end: every exit, a signal's too, stops the cluster and removes
 * its directory.
 */
const buildSchemaChecksCommand = (appId: string): string => {
	const data = `${BUILD_POSTGRES_DIR}/data`
	const stop = (mode: 'fast' | 'immediate'): string => `pg_ctl --pgdata=${data} --mode=${mode} stop >/dev/null`
	const failed = (check: string): string => `|| { echo "fabrika: the build check failed: ${check}" >&2; exit 1; }`
	const command = [
		'set -eu',
		'umask 077',
		`sudo apk add --no-cache --quiet ${BUILD_POSTGRES_PACKAGE}`,
		// A signal runs the EXIT trap only through an `exit` of its own, in POSIX `sh` and BusyBox `sh` alike.
		`trap "${stop('immediate')} 2>&1 || true; rm -rf ${BUILD_POSTGRES_DIR}" EXIT`,
		'trap "exit 130" INT',
		'trap "exit 143" TERM',
		`rm -rf ${BUILD_POSTGRES_DIR}`,
		`mkdir ${BUILD_POSTGRES_DIR}`,
		'PW=$(od -An -N16 -tx1 /dev/urandom | tr -dc 0-9a-f)',
		`printf %s "$PW" > ${BUILD_POSTGRES_DIR}/password`,
		`initdb --pgdata=${data} --username=fabrika --auth=scram-sha-256 --pwfile=${BUILD_POSTGRES_DIR}/password --no-sync --no-instructions >/dev/null`,
		`rm ${BUILD_POSTGRES_DIR}/password`,
		`pg_ctl --pgdata=${data} --log=${BUILD_POSTGRES_DIR}/server.log --wait --options="-c listen_addresses= -c unix_socket_directories=${BUILD_POSTGRES_DIR} -c fsync=off" start >/dev/null || { cat ${BUILD_POSTGRES_DIR}/server.log >&2; exit 1; }`,
		`export FABRIKA_APP_ID=${appId} FABRIKA_APP_DATABASE_URL="postgresql://fabrika:$PW@localhost/postgres?path=${BUILD_POSTGRES_DIR}"`,
		`${MIGRATE.join(' ')} ${failed('the migrations (fabrika db migrate)')}`,
		`${[FABRIKA_BIN, ...SCHEMA_TYPES_CHECK].join(' ')} ${failed('schema types are stale (fabrika db codegen --verify)')}`,
		`${stop('fast')} || ${stop('immediate')}`,
	].join('\n')
	// Zerops may resolve a braced `${name}` in a build command as its own variable; an unbraced `$NAME` reaches the shell.
	if (command.includes('${')) throw new Error('the build schema checks must expand no braced variable')
	return command
}

/**
 * The recipe of one contract application. The application's tests run first: they are authored code, so everything
 * after them is reinstalled, regenerated or checked again. They run as the application runs them, through the `test`
 * script of its `package.json`, so the build and the author's loop share one mode (which paths, `--isolate` or not, how
 * parallel). Without that script they run `bun test --isolate --pass-with-no-tests`, as the application skill runs
 * them: a test file's DOM globals otherwise leak into the next file. `tsc` runs before the checker, as in the skill's loop: the
 * usual quick fix of a type error is a cast or an `any`, which only the checker refuses, so the checker is the last word
 * on the code. With a database, the schema check runs last, on a throwaway PostgreSQL the build migrates from scratch,
 * and only the migrations run at container start; a build image without `apk` runs it as an init script instead, after
 * the migrations and before the readiness window opens.
 */
export function contractRecipe(input: ContractRecipeInput): ContractRecipe {
	const { appId, checkRelease, sourceRoot, runtimeRoot } = input
	if (!CONTRACT_APP_ID_PATTERN.test(appId)) throw new Error('a contract application id must match [a-z0-9][a-z0-9-]*')
	if (!FRAMEWORK_RELEASE_PATTERN.test(checkRelease)) throw new Error('the checker release must be a release version')
	if (input.jobs.some((job) => !CONTRACT_JOB_NAME_PATTERN.test(job.name) || !CRON_SCHEDULE_PATTERN.test(job.schedule))) {
		throw new Error('a job name or schedule is not one a generated crontab line may carry')
	}
	const script = (lines: readonly string[]): readonly string[] => ['#!/bin/sh', 'set -eu', `cd ${runtimeRoot}`, ...lines]
	const { database } = input
	const init = database === false
		? []
		: [
			{ path: MIGRATE_SCRIPT, lines: script([`FABRIKA_APP_ID=${appId} exec ${MIGRATE.join(' ')}`]) },
			// The committed schema types must match the migrated schema.
			...(database.schemaChecks === 'init'
				? [{ path: VERIFY_SCRIPT, lines: script([`FABRIKA_APP_ID=${appId} exec ${[FABRIKA_BIN, ...SCHEMA_TYPES_CHECK].join(' ')}`]) }]
				: []),
		]
	const { tsconfig, checks } = contractChecks(sourceRoot, checkRelease)
	const [tests, tsc, check] = checks
	return {
		build: [
			{ run: INSTALL },
			{ run: tests.command },
			{ run: `rm -rf node_modules && ${INSTALL}` },
			{ run: `bun -e "await import('@fabrika/app/build').then((build) => build.writeGeneratedEntry('.', 'bun'))"` },
			tsconfig,
			{ run: tsc.command },
			{ run: check.command },
			...(database !== false && database.schemaChecks === 'build' ? [{ run: CLI_RELEASE_CHECK }, { run: buildSchemaChecksCommand(appId) }] : []),
			...init.map((generated) => ({ write: generated.path, lines: generated.lines })),
			{ write: START_SCRIPT, lines: script([`exec ${SERVE.join(' ')}`]) },
			// After every check, so a map is uploaded only for a build that can deploy; the report line says how it went.
			...(input.sourceMaps ? [{ run: `cd /tmp && bun x --bun -p @fabrika/check@${checkRelease} fabrika-source-maps ${sourceRoot} || true` }] : []),
		],
		checks,
		init: init.map((generated) => generated.path),
		start: START_SCRIPT,
		serve: SERVE,
		migrate: MIGRATE,
		jobs: [
			...input.jobs.map((job) => ({ schedule: job.schedule, command: `${FABRIKA_BIN} job run ${job.name}` })),
			...(input.files ? [{ schedule: FILE_SWEEP_SCHEDULE, command: `${FABRIKA_BIN} job run ${FILE_SWEEP_JOB}` }] : []),
			...(input.scan ? [{ schedule: FILE_SCAN_SCHEDULE, command: `${FABRIKA_BIN} job run ${FILE_SCAN_JOB}` }] : []),
		],
	}
}
