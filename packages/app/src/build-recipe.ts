// The build, init and start of a contract application in a Bun container, as data (ADR-0043): the steps and their
// order are the platform's, never the repository's. A provider renders the recipe into its own build form, with its own
// paths, file writes and scheduler. PURE — no network, no filesystem.
//
// PLATFORM PROTOCOL, not framework API: the platform renders this with ITS copy for applications of older releases
// (ADR-0062), so the commands, script names and job names an application must accept change only additively. Never
// render the application's own copy.

import { APPLICATION_SERVER_MAX_HEADER_BYTES, FRAMEWORK_RELEASE_PATTERN } from '@fabrika/auth-core'
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
const SERVE_ENTRY = 'fabrika/entry.generated.ts'
const MIGRATE: readonly string[] = [FABRIKA_BIN, 'db', 'migrate']
const PLATFORM_TSCONFIG = 'fabrika/tsconfig.platform.json'

/**
 * The compiler options of the platform's type check; the application's own `tsconfig.json` and its `paths` are not read.
 * It covers the SPA under `web/` too: Bun bundles the SPA without checking its types.
 */
const PLATFORM_TSCONFIG_CONTENTS = JSON.stringify({
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
	include: ['../fabrika.contract.ts', '../src', '../web', 'entry.generated.ts'],
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

// The build has no database, so every Postgres-backed test file skips and the run still passes. This command runs the
// tests as before and then says how many files did not run, so a green test step does not read as a tested database.
const TESTS_COMMAND = bunEvalCommand([
	"const child = Bun.spawn([process.execPath, 'test', '--isolate', '--pass-with-no-tests'], { stdout: 'inherit', stderr: 'pipe' });",
	'const decoder = new TextDecoder();',
	"let output = '';",
	'for await (const chunk of child.stderr) { process.stderr.write(chunk); output += decoder.decode(chunk, { stream: true }) }',
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
	/** With a database, every container migrates and checks its schema before the server starts. */
	readonly database: boolean
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

export interface ContractRecipe {
	/** The steps after the authored SPA commands, in order. */
	readonly build: readonly ContractBuildStep[]
	/** The checks among `build`, in its order. */
	readonly checks: readonly ContractCheck[]
	/** The generated scripts every container runs before `start`, in order; any failure stops the activation. */
	readonly init: readonly string[]
	/** The generated script that starts the server, which only `exec`s it. */
	readonly start: string
	/** The generated entrypoint the start script serves, relative to the runtime root. */
	readonly entry: string
	/** The command that migrates the application's database, run from the runtime root. */
	readonly migrate: readonly string[]
	/** The jobs to schedule, each on one container; a command runs from the runtime root. */
	readonly jobs: readonly { readonly schedule: string; readonly command: string }[]
}

/**
 * The recipe of one contract application. The application's tests run first: they are authored code, so everything
 * after them is reinstalled, regenerated or checked again. They run `--isolate`, as the application skill runs them: a
 * test file's DOM globals otherwise leak into the next file. `tsc` runs before the checker, as in the skill's loop: the
 * usual quick fix of a type error is a cast or an `any`, which only the checker refuses, so the checker is the last word
 * on the code. The build has no database, so the schema checks run as init scripts, after the migrations and before the
 * readiness window opens.
 */
export function contractRecipe(input: ContractRecipeInput): ContractRecipe {
	const { appId, checkRelease, sourceRoot, runtimeRoot } = input
	if (!CONTRACT_APP_ID_PATTERN.test(appId)) throw new Error('a contract application id must match [a-z0-9][a-z0-9-]*')
	if (!FRAMEWORK_RELEASE_PATTERN.test(checkRelease)) throw new Error('the checker release must be a release version')
	if (input.jobs.some((job) => !CONTRACT_JOB_NAME_PATTERN.test(job.name) || !CRON_SCHEDULE_PATTERN.test(job.schedule))) {
		throw new Error('a job name or schedule is not one a generated crontab line may carry')
	}
	const script = (lines: readonly string[]): readonly string[] => ['#!/bin/sh', 'set -eu', `cd ${runtimeRoot}`, ...lines]
	const init = input.database
		? [
			{ path: MIGRATE_SCRIPT, lines: script([`FABRIKA_APP_ID=${appId} exec ${MIGRATE.join(' ')}`]) },
			// The committed schema types must match the migrated schema, and every generated isolation test must pass on a
			// throwaway schema.
			{
				path: VERIFY_SCRIPT,
				lines: script([`FABRIKA_APP_ID=${appId} ${FABRIKA_BIN} db codegen --verify`, `FABRIKA_APP_ID=${appId} exec ${FABRIKA_BIN} db test-isolation`]),
			},
		]
		: []
	const tests: ContractCheck = { name: 'tests', command: TESTS_COMMAND }
	const tsc: ContractCheck = { name: 'tsc', command: `cd /tmp && bun x --bun -p typescript@${PLATFORM_TYPESCRIPT_VERSION} tsc -p ${sourceRoot}/${PLATFORM_TSCONFIG}` }
	const check: ContractCheck = { name: 'fabrika-check', command: `cd /tmp && bun x --bun -p @fabrika/check@${checkRelease} fabrika-check ${sourceRoot}` }
	return {
		build: [
			{ run: INSTALL },
			{ run: tests.command },
			{ run: `rm -rf node_modules && ${INSTALL}` },
			{ run: `bun -e "await import('@fabrika/app/build').then((build) => build.writeGeneratedEntry('.', 'bun'))"` },
			{ write: PLATFORM_TSCONFIG, lines: [PLATFORM_TSCONFIG_CONTENTS] },
			{ run: tsc.command },
			{ run: check.command },
			...init.map((generated) => ({ write: generated.path, lines: generated.lines })),
			{ write: START_SCRIPT, lines: script([`exec bun --max-http-header-size=${APPLICATION_SERVER_MAX_HEADER_BYTES} ${SERVE_ENTRY}`]) },
			// After every check, so a map is uploaded only for a build that can deploy; the report line says how it went.
			...(input.sourceMaps ? [{ run: `cd /tmp && bun x --bun -p @fabrika/check@${checkRelease} fabrika-source-maps ${sourceRoot} || true` }] : []),
		],
		checks: [tests, tsc, check],
		init: init.map((generated) => generated.path),
		start: START_SCRIPT,
		entry: SERVE_ENTRY,
		migrate: MIGRATE,
		jobs: [
			...input.jobs.map((job) => ({ schedule: job.schedule, command: `${FABRIKA_BIN} job run ${job.name}` })),
			...(input.files ? [{ schedule: FILE_SWEEP_SCHEDULE, command: `${FABRIKA_BIN} job run ${FILE_SWEEP_JOB}` }] : []),
			...(input.scan ? [{ schedule: FILE_SCAN_SCHEDULE, command: `${FABRIKA_BIN} job run ${FILE_SCAN_JOB}` }] : []),
		],
	}
}
