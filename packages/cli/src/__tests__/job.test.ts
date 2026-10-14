// `fabrika job run <name>`: argument handling, the line it prints and its exit code. The run itself is
// `@fabrika/app/bun`'s `runContractJob`, witnessed against Postgres in the app package's jobs.test.ts.

import { BootError, JobError, type JobRunResult } from '@fabrika/app/implement'
import { describe, expect, test } from 'bun:test'
import { type JobCommandDependencies, runJobCommand } from '../job'

const ROOT = '/srv/notes'

function deps(result: JobRunResult | Error, contract = true) {
	const output: string[] = []
	const runs: { readonly name: string; readonly env: Readonly<Record<string, string | undefined>> }[] = []
	const dependencies: JobCommandDependencies = {
		cwd: ROOT,
		source: { FABRIKA_APP_ID: 'notes' },
		write: (line) => output.push(line),
		fileExists: (path) => Promise.resolve(contract && path === `${ROOT}/fabrika.contract.ts`),
		run: (_load, env, name) => {
			runs.push({ name, env })
			return result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
		},
	}
	return { dependencies, output, runs }
}

const failure = async (work: Promise<unknown>): Promise<string> => {
	try {
		await work
	} catch (error) {
		return error instanceof Error ? error.message : String(error)
	}
	throw new Error('the command did not fail')
}

describe('fabrika job run', () => {
	test('runs the named job with the environment and prints one line; a failed job exits 1', async () => {
		const succeeded = deps({ status: 'succeeded', attempts: 2 })
		expect(await runJobCommand('run', ['purge'], succeeded.dependencies)).toBe(0)
		expect(succeeded.output).toEqual(['job purge succeeded after 2 attempts\n'])
		expect(succeeded.runs).toEqual([{ name: 'purge', env: { FABRIKA_APP_ID: 'notes' } }])

		const failed = deps({ status: 'failed', attempts: 1, code: 'timeout' })
		expect(await runJobCommand('run', ['purge'], failed.dependencies)).toBe(1)
		expect(failed.output).toEqual(['job purge failed after 1 attempt: timeout\n'])

		const refused = deps({ status: 'failed', attempts: 1, code: 'query_refused', reason: 'undeclared_reach' })
		expect(await runJobCommand('run', ['purge'], refused.dependencies)).toBe(1)
		expect(refused.output).toEqual(['job purge failed after 1 attempt: query_refused: undeclared_reach\n'])

		const skipped = deps({ status: 'skipped' })
		expect(await runJobCommand('run', ['purge'], skipped.dependencies)).toBe(0)
		expect(skipped.output).toEqual(['job purge did not start: a previous run still holds its lease\n'])
	})

	test('refuses a missing name, an extra argument, another command and a directory without a contract', async () => {
		const { dependencies, runs } = deps({ status: 'succeeded', attempts: 1 })
		expect(await failure(runJobCommand('run', [], dependencies))).toStartWith('job run needs the name of a job')
		expect(await failure(runJobCommand('run', ['purge', '--now'], dependencies))).toStartWith('job run takes no argument --now')
		expect(await failure(runJobCommand('list', [], dependencies))).toStartWith('Unknown job command: list')
		expect(await failure(runJobCommand('run', ['purge'], deps({ status: 'succeeded', attempts: 1 }, false).dependencies))).toBe(
			'job run: no fabrika.contract.ts in /srv/notes; run it from the application root',
		)
		expect(runs).toEqual([])
	})

	test('only the framework’s own errors keep their message; anything else, named like one or not, is boot_failed', async () => {
		const boot = new BootError(['job purge has no handler; add it to handlers.jobs'])
		expect(await failure(runJobCommand('run', ['purge'], deps(boot).dependencies))).toBe(boot.message)
		const unknown = new JobError("no job 'nightly' in the contract (jobs: purge)")
		expect(await failure(runJobCommand('run', ['nightly'], deps(unknown).dependencies))).toBe(unknown.message)
		for (const name of ['BootError', 'JobError', 'Error']) {
			const leaked = new Error('connect ECONNREFUSED postgres://notes:s3cret@db:5432/notes')
			leaked.name = name
			expect(await failure(runJobCommand('run', ['purge'], deps(leaked).dependencies))).toBe('the job could not run: boot_failed')
		}
	})
})
