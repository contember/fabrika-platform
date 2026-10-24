// The launcher of a `dev` environment: ADR-0017's launcher, kept as the parent for the life of the container. It holds
// the provisioning credential and the `source` key, loads no application module, and runs the serving entry with the
// runtime credential only. It holds a long poll on Control's source receiver (ADR-0064); a new head brings the changed
// files, which it writes, then it migrates when `db/migrations/` changed, runs the SPA commands when a web source
// changed, and respawns the application. A change the build owns is refused with one line: it needs a bootstrap run.

import {
	DEV_LAUNCHER_CONFIG_FILE,
	DEV_LAUNCHER_STATE_FILE,
	type DevLauncherConfig,
	FABRIKA_CONTRACT_DIGEST,
	platformTransportVariables,
} from '@fabrika/auth-core'
import { applicationRuntimeUrl, dropApplicationDatabase } from '@fabrika/platform-node'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod/v4'
import { makeProcessUndumpable } from '../undumpable.js'
import { bootstrapReason, migrationsChanged, webSourceChanged } from './changes.js'
import { OutputRing, type OutputSink, type OutputStream, processOutput, readLines } from './output.js'
import {
	DEV_SOURCE_REPORT_PATH,
	DEV_SOURCE_WAIT_MS,
	DEV_SOURCE_WAIT_PATH,
	type DevCheckResult,
	type DevReport,
	type DevStatus,
	type DevSync,
	type DevWaitAnswer,
	encodeDevReport,
	encodeDevWaitRequest,
	parseDevWaitAnswer,
} from './wire.js'

const PROVISIONING_DATABASE_URL = 'FABRIKA_APP_DATABASE_URL'
const RUNTIME_DATABASE_URL = 'FABRIKA_APP_RUNTIME_DATABASE_URL'
const SOURCE = platformTransportVariables('source')

/** Lines kept, and lines one report carries. */
const RING_LINES = 500
const REPORT_LINES = 100
/** A check's output reported: its last lines. */
const CHECK_OUTPUT_LINES = 60
const HEALTH_TIMEOUT_MS = 30_000
const STOP_GRACE_MS = 3_000
const CHECK_TIMEOUT_MS = 10 * 60_000
const CRASH_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000] as const
const FORWARDED_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const
const DIGEST_TIMEOUT_MS = 60_000
const CONTRACT_DIGEST = /^sha256:[0-9a-f]{64}$/
const CONTRACT_DIGEST_CHILD = fileURLToPath(new URL('./contract-digest.ts', import.meta.url))

const commitSha = z.string().regex(/^[0-9a-f]{40}$/)
/** A literal path of unreserved characters, as the provider's readiness probe requests it. */
const HEALTH_PATH = /^(?:\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)+$/

const configSchema: z.ZodType<DevLauncherConfig> = z.object({
	format: z.literal(1),
	appId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
	head: commitSha,
	port: z.number().int().min(1).max(65535),
	healthPath: z.string().regex(HEALTH_PATH),
	serve: z.array(z.string()).min(1),
	migrate: z.array(z.string()).min(1),
	spaBuild: z.array(z.string()),
	checks: z.array(z.object({ name: z.string().min(1).max(64), command: z.string().min(1) }).strict()),
}).strict()

const stateSchema = z.object({
	head: commitSha,
	reset: z.number().int().min(0).nullable(),
	checks: z.number().int().min(0).nullable(),
}).strict()

type LauncherState = z.infer<typeof stateSchema>

/** The launcher's configuration, which the build generated; a missing or malformed file stops the launch. */
export async function readDevLauncherConfig(root: string): Promise<DevLauncherConfig> {
	const text = await readFile(join(root, DEV_LAUNCHER_CONFIG_FILE), 'utf8').catch(() => null)
	if (text === null) throw new Error(`fabrika dev: ${DEV_LAUNCHER_CONFIG_FILE} is missing; only the build of a dev environment writes it`)
	const parsed = configSchema.safeParse(JSON.parse(text))
	if (!parsed.success) throw new Error(`fabrika dev: ${DEV_LAUNCHER_CONFIG_FILE} is not a launcher configuration this release reads`)
	return parsed.data
}

/** What the state file holds, or the build's head for a container that has none (a new one). */
async function readState(root: string, config: DevLauncherConfig): Promise<LauncherState> {
	const text = await readFile(join(root, DEV_LAUNCHER_STATE_FILE), 'utf8').catch(() => null)
	const parsed = text === null ? null : stateSchema.safeParse(JSON.parse(text))
	return parsed?.success === true ? parsed.data : { head: config.head, reset: null, checks: null }
}

export interface DevSourceTransport {
	readonly url: string
	readonly key: string
}

export interface DevLauncherOptions {
	readonly root: string
	readonly config: DevLauncherConfig
	/** The launcher's own environment: the application's, with the provisioning credential and the `source` key. */
	readonly environment: Readonly<Record<string, string>>
	readonly source: DevSourceTransport
	readonly fetch?: (request: Request) => Promise<Response>
	readonly output?: OutputSink
	/** How long a boot tries to reach Control before it serves the files it holds. */
	readonly bootReconcileMs?: number
}

export interface DevLauncher {
	/** Settles once the first boot served, or failed and reported it. */
	readonly ready: Promise<void>
	/** Stop the long poll and the application. */
	stop(): Promise<void>
}

interface RunningApplication {
	readonly process: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
	readonly exited: Promise<number>
	stopping: boolean
}

interface CommandResult {
	readonly exitCode: number | null
	/** The signal that ended the command, when one did: it never exited on its own. */
	readonly signal: string | null
	readonly lines: readonly string[]
}

/** Bun echoes the script it runs (`$ bun build-web.ts`) on stderr; it names the command, not a failure. */
const BUN_SCRIPT_ECHO = /^\$ \S/

type SyncOutcome =
	| { readonly kind: 'applied'; readonly migrations: boolean; readonly spaFailure: string | null }
	| { readonly kind: 'refused'; readonly reason: string }

/** Control answers 409 to the container of a bootstrap run that a newer one replaced. */
class SupersededError extends Error {}

const SUPERSEDED = 'a newer bootstrap run replaced this container; it stops following Control and serves until it is stopped'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Every value of the environment a log line must never show: the database credentials and every key, secret or token. */
function secretValues(environment: Readonly<Record<string, string>>, runtimeUrl: string | null): string[] {
	const values = new Set<string>()
	const add = (value: string | undefined): void => {
		if (value !== undefined && value.length >= 8) values.add(value)
	}
	for (const url of [environment[PROVISIONING_DATABASE_URL], runtimeUrl ?? undefined]) {
		add(url)
		if (url !== undefined && URL.canParse(url)) add(decodeURIComponent(new URL(url).password))
	}
	for (const [name, value] of Object.entries(environment)) {
		if (/(KEY|SECRET|PASSWORD|TOKEN|DATABASE_URL)$/.test(name)) add(value)
	}
	return [...values].sort((left, right) => right.length - left.length)
}

const withoutFramework = (environment: Readonly<Record<string, string>>): Record<string, string> =>
	Object.fromEntries(Object.entries(environment).filter(([name]) => !name.startsWith('FABRIKA_')))

/** Start the launcher: reconcile to the recorded head, serve, then follow Control's long poll. */
export function startDevLauncher(options: DevLauncherOptions): DevLauncher {
	const launcher = new Launcher(options)
	return { ready: launcher.start(), stop: () => launcher.stop() }
}

class Launcher {
	private readonly root: string
	private readonly config: DevLauncherConfig
	private readonly fetch: (request: Request) => Promise<Response>
	private readonly provisioningUrl: string | null
	private readonly applicationEnvironment: Record<string, string>
	private readonly commandEnvironment: Record<string, string>
	private readonly ring: OutputRing
	private readonly controller = new AbortController()
	private state: LauncherState = { head: '', reset: null, checks: null }
	private status: DevStatus = 'syncing'
	private target: string | null = null
	private message: string | null = null
	private checkResults: DevReport['checks'] = null
	private application: RunningApplication | null = null
	private actions: Promise<void> = Promise.resolve()
	private crashes = 0
	private stopped = false
	private reportFailing = false
	/** A newer bootstrap run replaced this container: it keeps serving until the platform stops it, and asks nothing. */
	private superseded = false

	constructor(private readonly options: DevLauncherOptions) {
		this.root = options.root
		this.config = options.config
		this.fetch = options.fetch ?? ((request) => fetch(request))
		const provisioning = options.environment[PROVISIONING_DATABASE_URL] ?? ''
		this.provisioningUrl = provisioning === '' ? null : provisioning
		const runtimeUrl = this.provisioningUrl === null ? null : applicationRuntimeUrl(this.provisioningUrl, this.config.appId)
		const application: Record<string, string> = {}
		for (const [name, value] of Object.entries(options.environment)) {
			if (name !== PROVISIONING_DATABASE_URL && name !== SOURCE.url && name !== SOURCE.key) application[name] = value
		}
		if (runtimeUrl !== null) application[RUNTIME_DATABASE_URL] = runtimeUrl
		this.applicationEnvironment = application
		this.commandEnvironment = withoutFramework(options.environment)
		this.ring = new OutputRing(RING_LINES, secretValues(options.environment, runtimeUrl), options.output ?? processOutput)
	}

	async start(): Promise<void> {
		this.state = await readState(this.root, this.config)
		const answer = await this.firstAnswer()
		await this.enqueue(() => this.apply(answer ?? { sync: null, reset: this.state.reset ?? 0, checks: this.state.checks ?? 0 }, true))
		void this.follow()
	}

	async stop(): Promise<void> {
		this.stopped = true
		this.controller.abort()
		await this.actions
		await this.stopApplication()
	}

	private say(line: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
		this.ring.push(stream, `fabrika dev: ${line}`)
	}

	/** Actions run one at a time: a sync, a reset, a check run and a respawn after a crash never interleave. */
	private enqueue(action: () => Promise<void>): Promise<void> {
		const next = this.actions.then(action, action)
		this.actions = next.catch(() => undefined)
		return next
	}

	/** At boot: the answer for the head this container holds, without holding, so the launcher reconciles before it serves. */
	private async firstAnswer(): Promise<DevWaitAnswer | null> {
		const deadline = Date.now() + (this.options.bootReconcileMs ?? 20_000)
		while (!this.stopped) {
			try {
				return await this.wait(false)
			} catch (error) {
				if (error instanceof SupersededError) {
					this.say(SUPERSEDED, 'stderr')
					this.superseded = true
					return null
				}
				if (Date.now() >= deadline) {
					this.say('Control did not answer at boot; serving the files this container holds', 'stderr')
					return null
				}
				await sleep(1_000)
			}
		}
		return null
	}

	private async follow(): Promise<void> {
		let backoff = 1_000
		while (!this.stopped && !this.superseded) {
			let answer: DevWaitAnswer
			try {
				answer = await this.wait(true)
				backoff = 1_000
			} catch (error) {
				if (this.stopped) return
				if (error instanceof SupersededError) {
					this.say(SUPERSEDED, 'stderr')
					this.superseded = true
					return
				}
				this.say(`the long poll on Control failed; retrying in ${backoff / 1000} s`, 'stderr')
				await sleep(backoff)
				backoff = Math.min(backoff * 2, 15_000)
				continue
			}
			await this.enqueue(() => this.apply(answer, false))
		}
	}

	private async wait(hold: boolean): Promise<DevWaitAnswer> {
		const body = encodeDevWaitRequest({
			bootstrap: this.config.head,
			head: this.state.head,
			reset: this.state.reset,
			checks: this.state.checks,
			hold,
		})
		const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(DEV_SOURCE_WAIT_MS + 15_000)])
		const response = await this.fetch(this.request(DEV_SOURCE_WAIT_PATH, body, signal))
		if (response.status === 409) {
			await response.body?.cancel()
			throw new SupersededError()
		}
		if (!response.ok) throw new Error(`the source receiver answered ${response.status}`)
		const parsed = parseDevWaitAnswer(await response.json())
		if (!parsed.ok) throw new Error('the source receiver answered a body this release does not read')
		return parsed.value
	}

	private request(path: string, body: string, signal: AbortSignal): Request {
		return new Request(new URL(path, this.options.source.url), {
			method: 'POST',
			headers: { authorization: `Bearer ${this.options.source.key}`, 'content-type': 'application/json' },
			body,
			signal,
		})
	}

	private async report(): Promise<void> {
		if (this.superseded) return
		const body = encodeDevReport({
			bootstrap: this.config.head,
			head: this.state.head,
			status: this.status,
			target: this.target,
			message: this.message,
			log: this.ring.tail(REPORT_LINES),
			reset: this.state.reset,
			checks: this.checkResults,
		})
		try {
			const response = await this.fetch(this.request(DEV_SOURCE_REPORT_PATH, body, AbortSignal.timeout(10_000)))
			await response.body?.cancel()
			if (!response.ok) throw new Error(`the source receiver answered ${response.status}`)
			this.reportFailing = false
		} catch {
			if (!this.reportFailing) this.say('reporting to Control failed; the next report retries', 'stderr')
			this.reportFailing = true
		}
	}

	private async apply(answer: DevWaitAnswer, boot: boolean): Promise<void> {
		if (this.state.reset === null) this.state = { ...this.state, reset: answer.reset }
		if (this.state.checks === null) this.state = { ...this.state, checks: answer.checks }
		let changed = boot
		let migrate = boot
		let spaFailure: string | null = null
		const reset = answer.reset > (this.state.reset ?? answer.reset)
		if (answer.sync !== null || reset) this.ring.mark()
		if (answer.sync !== null) {
			const outcome = await this.writeSync(answer.sync)
			if (outcome.kind === 'refused') {
				this.status = 'needs_bootstrap'
				this.target = answer.sync.to
				this.message = outcome.reason
				this.say(outcome.reason, 'stderr')
				await this.report()
			} else {
				changed = true
				migrate ||= outcome.migrations
				spaFailure = outcome.spaFailure
			}
		}
		if (changed || reset) await this.converge({ migrate: migrate || reset, reset, spaFailure, resetTo: answer.reset })
		if (answer.checks > (this.state.checks ?? answer.checks)) await this.check(answer.checks)
	}

	/** Bring the database, the SPA and the running application to the files on disk, then report. */
	private async converge(steps: { migrate: boolean; reset: boolean; spaFailure: string | null; resetTo: number }): Promise<void> {
		this.status = steps.reset ? 'resetting' : 'syncing'
		void this.report()
		let failure: string | null = null
		// A migration's ALTER would queue behind the live version's locks, and a reset drops the role it connects as.
		if (this.provisioningUrl !== null && steps.migrate) await this.stopApplication()
		if (steps.reset) {
			failure = await this.timed('the reset', () => this.resetDatabase())
			this.state = { ...this.state, reset: steps.resetTo }
		}
		if (failure === null && steps.migrate) failure = await this.timed('the migration', () => this.migrate())
		if (failure === null) failure = steps.spaFailure
		const served = await this.timed('the restart until healthy', () => this.restartApplication())
		failure ??= served
		this.status = failure === null ? 'serving' : 'failed'
		this.target = null
		this.message = failure
		await this.persist()
		await this.report()
	}

	/** Run one step of a sync and log how long it took: what a slow `apply_changes` is read from. */
	private async timed(step: string, run: () => Promise<string | null>): Promise<string | null> {
		const started = performance.now()
		const failure = await run()
		this.say(`${step} ${failure === null ? 'took' : 'failed after'} ${Math.round(performance.now() - started)} ms`)
		return failure
	}

	private async writeSync(sync: DevSync): Promise<SyncOutcome> {
		if (sync.from !== this.state.head) {
			return { kind: 'refused', reason: `Control sent changes from ${sync.from}, and this container holds ${this.state.head}; call bind_dev again` }
		}
		const paths = sync.files.map((file) => file.path)
		const reason = bootstrapReason(paths)
		if (reason !== null) return { kind: 'refused', reason }
		const previous = await Promise.all(
			sync.files.map(async (file) => ({ path: file.path, content: await readFile(join(this.root, file.path)).catch(() => null) })),
		)
		await this.writeFiles(sync.files)
		const web = this.config.spaBuild.length > 0 && webSourceChanged(paths)
		// The SPA build runs beside the digest: a refusal is rare, and then the build runs again over the restored files.
		const [changedContract, spaFailure] = await Promise.all([this.contractChange(), web ? this.spaBuild() : null])
		if (changedContract !== null) {
			await this.writeFiles(previous)
			if (web) await this.spaBuild()
			return { kind: 'refused', reason: changedContract }
		}
		this.state = { ...this.state, head: sync.to }
		this.say(`synced ${sync.files.length} files to ${sync.to}`)
		return { kind: 'applied', migrations: migrationsChanged(paths), spaFailure }
	}

	private spaBuild(): Promise<string | null> {
		return this.timed('the SPA build', () => this.buildSpa())
	}

	private async writeFiles(files: readonly { readonly path: string; readonly content: string | Uint8Array | null }[]): Promise<void> {
		for (const file of files) {
			const path = join(this.root, file.path)
			if (file.content === null) {
				await rm(path, { force: true })
				continue
			}
			await mkdir(dirname(path), { recursive: true })
			await writeFile(`${path}.fabrika-dev`, file.content)
			await rename(`${path}.fabrika-dev`, path)
		}
	}

	/**
	 * Why the files on disk need a bootstrap run because their contract digest is not the one the bootstrap run deployed,
	 * or null. A child computes it: it loads the application module, which the launcher never does, with no credential.
	 * A digest it cannot compute is no reason: the respawned application then fails to boot and reports why.
	 */
	private async contractChange(): Promise<string | null> {
		const deployed = this.options.environment[FABRIKA_CONTRACT_DIGEST] ?? ''
		if (deployed === '') return null
		const started = performance.now()
		const child = Bun.spawn(['bun', CONTRACT_DIGEST_CHILD], {
			cwd: this.root,
			env: { PATH: this.options.environment['PATH'] ?? '', HOME: this.options.environment['HOME'] ?? '' },
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
		})
		const timer = setTimeout(() => child.kill('SIGKILL'), DIGEST_TIMEOUT_MS)
		const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
		clearTimeout(timer)
		const digest = stdout.trim()
		if (child.exitCode !== 0 || !CONTRACT_DIGEST.test(digest)) {
			for (const line of stderr.split('\n').filter((text) => text.trim() !== '').slice(-5)) this.ring.push('stderr', line)
			this.say('the contract digest could not be computed; the application is respawned and reports why', 'stderr')
			return null
		}
		this.say(`contract digest computed in ${Math.round(performance.now() - started)} ms`)
		if (digest === deployed) return null
		return `the change alters the contract (its digest is ${digest}, and the bootstrap run deployed ${deployed}): the proxy table and `
			+ 'the approval follow the contract, so that needs a bootstrap run: call bind_dev again'
	}

	private async persist(): Promise<void> {
		const path = join(this.root, DEV_LAUNCHER_STATE_FILE)
		await mkdir(dirname(path), { recursive: true })
		await writeFile(`${path}.tmp`, JSON.stringify(this.state))
		await rename(`${path}.tmp`, path)
	}

	private async migrate(): Promise<string | null> {
		if (this.provisioningUrl === null) return null
		const result = await this.run(this.config.migrate, {
			...this.commandEnvironment,
			FABRIKA_APP_ID: this.config.appId,
			[PROVISIONING_DATABASE_URL]: this.provisioningUrl,
		})
		if (result.exitCode === 0) return null
		return `fabrika db migrate failed: ${lastLine(result)}; if an applied migration changed, call reset_dev`
	}

	private async resetDatabase(): Promise<string | null> {
		if (this.provisioningUrl === null) return null
		this.say(`dropping the schema and roles of ${this.config.appId}`)
		try {
			await dropApplicationDatabase(this.provisioningUrl, this.config.appId)
			return null
		} catch (error) {
			// The driver's error may quote the URL, so only its class is named.
			this.say(`dropping the schema failed (${error instanceof Error ? error.name : 'unknown error'})`, 'stderr')
			return "dropping the environment's schema and roles failed; see the log"
		}
	}

	private async buildSpa(): Promise<string | null> {
		for (const command of this.config.spaBuild) {
			const result = await this.run(
				['sh', '-c', command],
				this.commandEnvironment,
				CHECK_TIMEOUT_MS,
				(stream, line) => stream === 'stderr' && BUN_SCRIPT_ECHO.test(line) ? 'stdout' : stream,
			)
			if (result.exitCode !== 0) return `the SPA command \`${command}\` failed: ${lastLine(result)}`
		}
		return null
	}

	private async check(request: number): Promise<void> {
		const before = { status: this.status, message: this.message }
		this.status = 'checking'
		await this.report()
		const results: DevCheckResult[] = []
		for (const check of this.config.checks) {
			this.say(`check ${check.name}: ${check.command}`)
			const started = performance.now()
			const result = await this.run(['sh', '-c', check.command], this.commandEnvironment, CHECK_TIMEOUT_MS)
			const durationMs = Math.round(performance.now() - started)
			const killed = result.signal === null ? [] : [killedLine(check.name, result.signal, durationMs >= CHECK_TIMEOUT_MS)]
			for (const line of killed) this.say(line, 'stderr')
			results.push({
				name: check.name,
				ok: result.exitCode === 0,
				exitCode: result.exitCode,
				durationMs,
				output: [...result.lines.slice(-(CHECK_OUTPUT_LINES - killed.length)), ...killed].map((line) => line.slice(0, 2_000)),
			})
		}
		this.checkResults = { request, head: this.state.head, results }
		this.state = { ...this.state, checks: request }
		this.status = before.status
		this.message = before.message
		await this.persist()
		await this.report()
	}

	/** Run a command in the root; its output goes to the log, and its lines are returned. */
	private async run(
		argv: readonly string[],
		env: Record<string, string>,
		timeoutMs = CHECK_TIMEOUT_MS,
		classify: (stream: OutputStream, line: string) => OutputStream = (stream) => stream,
	): Promise<CommandResult> {
		const child = Bun.spawn([...argv], { cwd: this.root, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
		const lines: string[] = []
		const collect = (stream: OutputStream) => (line: string) => {
			lines.push(line)
			this.ring.push(classify(stream, line), line)
		}
		const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
		await Promise.all([readLines(child.stdout, collect('stdout')), readLines(child.stderr, collect('stderr')), child.exited])
		clearTimeout(timer)
		return { exitCode: child.exitCode, signal: child.signalCode === null ? null : String(child.signalCode), lines }
	}

	private async restartApplication(): Promise<string | null> {
		await this.stopApplication()
		const running = this.spawnApplication()
		const failure = await this.awaitHealthy(running)
		if (failure === null) this.crashes = 0
		return failure
	}

	private spawnApplication(): RunningApplication {
		const child = Bun.spawn([...this.config.serve], {
			cwd: this.root,
			env: this.applicationEnvironment,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
		})
		void readLines(child.stdout, (line) => this.ring.push('stdout', line))
		void readLines(child.stderr, (line) => this.ring.push('stderr', line))
		const running: RunningApplication = { process: child, exited: child.exited, stopping: false }
		this.application = running
		void running.exited.then((code) => {
			if (running.stopping || this.stopped || this.application !== running) return
			this.application = null
			this.crashed(code)
		})
		return running
	}

	/** An application that exited on its own is reported and respawned after a growing pause. */
	private crashed(code: number): void {
		const pause = CRASH_BACKOFF_MS[Math.min(this.crashes, CRASH_BACKOFF_MS.length - 1)] ?? 10_000
		this.crashes += 1
		this.status = 'failed'
		this.message = `the application exited with code ${code}; it restarts in ${pause / 1000} s`
		this.say(this.message, 'stderr')
		void this.report()
		setTimeout(() => {
			if (this.stopped) return
			void this.enqueue(async () => {
				if (this.application !== null || this.stopped) return
				const failure = await this.restartApplication()
				this.status = failure === null ? 'serving' : 'failed'
				this.message = failure
				await this.report()
			})
		}, pause)
	}

	private async awaitHealthy(running: RunningApplication): Promise<string | null> {
		const url = `http://127.0.0.1:${this.config.port}${this.config.healthPath}`
		const deadline = Date.now() + HEALTH_TIMEOUT_MS
		let exited: number | null = null
		void running.exited.then((code) => {
			exited = code
		})
		while (Date.now() < deadline) {
			if (exited !== null) return `the application exited with code ${exited} before it served; see the log`
			try {
				const response = await fetch(url, { signal: AbortSignal.timeout(1_000) })
				await response.body?.cancel()
				if (response.ok) return null
			} catch {
				// Not listening yet.
			}
			await sleep(25)
		}
		return `the application did not answer ${this.config.healthPath} within ${HEALTH_TIMEOUT_MS / 1000} s`
	}

	private async stopApplication(): Promise<void> {
		const running = this.application
		if (running === null) return
		running.stopping = true
		this.application = null
		running.process.kill('SIGTERM')
		const timer = setTimeout(() => running.process.kill('SIGKILL'), STOP_GRACE_MS)
		await running.exited
		clearTimeout(timer)
	}
}

/** Why a check has no exit code: the launcher's timeout, or a signal from outside, most often the out-of-memory killer. */
const killedLine = (name: string, signal: string, timedOut: boolean): string =>
	timedOut
		? `check ${name} was killed (${signal}) after the ${CHECK_TIMEOUT_MS / 60_000}-minute timeout; it failed`
		: `check ${name} was killed (${signal}) before it finished, most likely because the container ran out of memory; it failed`

const lastLine = (result: CommandResult): string => [...result.lines].reverse().find((line) => line.trim() !== '')?.trim() ?? 'no output'

/** The process environment with its string values only. */
function stringEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
	const strings: Record<string, string> = {}
	for (const [name, value] of Object.entries(env)) {
		if (value !== undefined) strings[name] = value
	}
	return strings
}

/**
 * The generated dev entrypoint's only call. It reads the build's configuration and the `source` transport, makes
 * itself non-dumpable (it holds the provisioning credential and the key), and runs until a signal stops it.
 */
export async function runDevLauncher(env: Readonly<Record<string, string | undefined>>): Promise<void> {
	const root = process.cwd()
	const config = await readDevLauncherConfig(root)
	const environment = stringEnvironment(env)
	const url = environment[SOURCE.url] ?? ''
	const key = environment[SOURCE.key] ?? ''
	if (url === '' || key === '') {
		throw new Error(`fabrika dev: ${SOURCE.url} and ${SOURCE.key} are not set; the platform writes them for a dev environment`)
	}
	makeProcessUndumpable()
	const launcher = startDevLauncher({ root, config, environment, source: { url, key } })
	for (const signal of FORWARDED_SIGNALS) {
		process.once(signal, () => void launcher.stop().then(() => process.exit(0)))
	}
	await launcher.ready
}
