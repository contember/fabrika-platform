import { CONTRACT_FILE, IMPLEMENTATION_FILE } from '@fabrika/app/build'
import { implementationAt, type ImplementationLoader, runContractJob } from '@fabrika/app/bun'
import { BootError, JobError, type JobRunResult } from '@fabrika/app/implement'
import { join } from 'node:path'

export const JOB_USAGE = `fabrika job — an application's c.cron jobs

Usage:
  fabrika job run <name>    Run the job <name> of ${CONTRACT_FILE} once: the command every crontab entry runs.
                            The framework's own fabrika-file-scan scans the uploads of scan: true file collections.

Run from the application root. The job boots like the server: the framework variables (FABRIKA_APP_ID,
FABRIKA_APP_DATABASE_URL, FABRIKA_IAM_*, FABRIKA_CONTRACT_DIGEST, FABRIKA_PROXY_SECRET, FABRIKA_OPERATIONS_DSN)
come from the environment only and leave the process before ${IMPLEMENTATION_FILE} loads; the run itself happens in a
process started again with the runtime role's credential in place of FABRIKA_APP_DATABASE_URL. A run takes the job's lease
or does not start. It exits 1 when the job failed, and 0 when it succeeded or a previous run still holds the lease.
A failure is named by a fixed code (timeout, lease_lost, handler_failed, driver_failed, boot_failed), never by the
application's error.
`

export interface JobCommandDependencies {
	/** The application root. */
	readonly cwd: string
	readonly source: Readonly<Record<string, string | undefined>>
	readonly write: (line: string) => void
	readonly fileExists: (path: string) => Promise<boolean>
	readonly run: (load: ImplementationLoader, env: Readonly<Record<string, string | undefined>>, name: string) => Promise<JobRunResult>
}

/**
 * The framework's own errors keep their message; anything else (an error importing or booting the application, a
 * driver error) is `boot_failed`, because its name and message may carry a secret or the database URL.
 */
const reportable = (error: unknown): Error =>
	error instanceof BootError || error instanceof JobError ? error : new Error('the job could not run: boot_failed')

const plural = (attempts: number): string => `${attempts} attempt${attempts === 1 ? '' : 's'}`

const summary = (name: string, result: JobRunResult): string => {
	switch (result.status) {
		case 'succeeded':
			return `job ${name} succeeded after ${plural(result.attempts)}`
		case 'failed':
			return `job ${name} failed after ${plural(result.attempts)}: ${result.code}`
		case 'skipped':
			return `job ${name} did not start: a previous run still holds its lease`
	}
}

/** Runs one job and answers the process exit code. */
export const runJobCommand = async (command: string | undefined, argv: readonly string[], deps: JobCommandDependencies): Promise<number> => {
	if (command !== 'run') throw new Error(`Unknown job command: ${command ?? '(missing)'}\n\n${JOB_USAGE}`)
	const [name, ...extra] = argv
	if (name === undefined || name.startsWith('-')) throw new Error(`job run needs the name of a job\n\n${JOB_USAGE}`)
	if (extra.length > 0) throw new Error(`job run takes no argument ${extra[0]}\n\n${JOB_USAGE}`)
	if (!(await deps.fileExists(join(deps.cwd, CONTRACT_FILE)))) {
		throw new Error(`job run: no ${CONTRACT_FILE} in ${deps.cwd}; run it from the application root`)
	}
	let result: JobRunResult
	try {
		result = await deps.run(implementationAt(join(deps.cwd, IMPLEMENTATION_FILE)), deps.source, name)
	} catch (error) {
		throw reportable(error)
	}
	deps.write(`${summary(name, result)}\n`)
	return result.status === 'failed' ? 1 : 0
}

/** The process ends with the run, so nothing a handler left running outlives it. */
export const runJobCli = async (command: string | undefined, argv: readonly string[]): Promise<never> => {
	const code = await runJobCommand(command, argv, {
		cwd: process.cwd(),
		source: process.env,
		write: (line) => process.stdout.write(line),
		fileExists: (path) => Bun.file(path).exists(),
		run: (load, env, name) => runContractJob(load, env, name),
	})
	process.exit(code)
}
