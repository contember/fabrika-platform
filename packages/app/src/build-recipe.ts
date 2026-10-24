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
const PLATFORM_TSCONFIG = 'fabrika/tsconfig.platform.json'

/** The compiler options of the platform's type check; the application's own `tsconfig.json` and its `paths` are not read. */
const PLATFORM_TSCONFIG_CONTENTS = JSON.stringify({
	compilerOptions: {
		target: 'ES2022',
		module: 'ESNext',
		moduleResolution: 'bundler',
		lib: ['ES2022', 'DOM', 'DOM.Iterable'],
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
	include: ['../fabrika.contract.ts', '../src', 'entry.generated.ts'],
})

const INSTALL = 'bun install --frozen-lockfile --ignore-scripts'

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

export interface ContractRecipe {
	/** The steps after the authored SPA commands, in order. */
	readonly build: readonly ContractBuildStep[]
	/** The generated scripts every container runs before `start`, in order; any failure stops the activation. */
	readonly init: readonly string[]
	/** The generated script that starts the server, which only `exec`s it. */
	readonly start: string
	/** The jobs to schedule, each on one container; a command runs from the runtime root. */
	readonly jobs: readonly { readonly schedule: string; readonly command: string }[]
}

/**
 * The recipe of one contract application. The application's tests run first: they are authored code, so everything
 * after them is reinstalled, regenerated or checked again. They run `--isolate`, as the application skill runs them: a
 * test file's DOM globals otherwise leak into the next file. The build has no database, so the schema checks run as
 * init scripts, after the migrations and before the readiness window opens.
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
			{ path: MIGRATE_SCRIPT, lines: script([`FABRIKA_APP_ID=${appId} exec ${FABRIKA_BIN} db migrate`]) },
			// The committed schema types must match the migrated schema, and every generated isolation test must pass on a
			// throwaway schema.
			{
				path: VERIFY_SCRIPT,
				lines: script([`FABRIKA_APP_ID=${appId} ${FABRIKA_BIN} db codegen --verify`, `FABRIKA_APP_ID=${appId} exec ${FABRIKA_BIN} db test-isolation`]),
			},
		]
		: []
	return {
		build: [
			{ run: INSTALL },
			{ run: 'bun test --isolate --pass-with-no-tests' },
			{ run: `rm -rf node_modules && ${INSTALL}` },
			{ run: `bun -e "await import('@fabrika/app/build').then((build) => build.writeGeneratedEntry('.', 'bun'))"` },
			{ run: `cd /tmp && bun x --bun -p @fabrika/check@${checkRelease} fabrika-check ${sourceRoot}` },
			{ write: PLATFORM_TSCONFIG, lines: [PLATFORM_TSCONFIG_CONTENTS] },
			{ run: `cd /tmp && bun x --bun -p typescript@${PLATFORM_TYPESCRIPT_VERSION} tsc -p ${sourceRoot}/${PLATFORM_TSCONFIG}` },
			...init.map((generated) => ({ write: generated.path, lines: generated.lines })),
			{ write: START_SCRIPT, lines: script([`exec bun --max-http-header-size=${APPLICATION_SERVER_MAX_HEADER_BYTES} fabrika/entry.generated.ts`]) },
			// After every check, so a map is uploaded only for a build that can deploy; the report line says how it went.
			...(input.sourceMaps ? [{ run: `cd /tmp && bun x --bun -p @fabrika/check@${checkRelease} fabrika-source-maps ${sourceRoot} || true` }] : []),
		],
		init: init.map((generated) => generated.path),
		start: START_SCRIPT,
		jobs: [
			...input.jobs.map((job) => ({ schedule: job.schedule, command: `${FABRIKA_BIN} job run ${job.name}` })),
			...(input.files ? [{ schedule: FILE_SWEEP_SCHEDULE, command: `${FABRIKA_BIN} job run ${FILE_SWEEP_JOB}` }] : []),
			...(input.scan ? [{ schedule: FILE_SCAN_SCHEDULE, command: `${FABRIKA_BIN} job run ${FILE_SCAN_JOB}` }] : []),
		],
	}
}
