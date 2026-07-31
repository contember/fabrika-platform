// The in-container run engine — pure of HTTP, so it's unit-testable with a fake command runner.
//
// A `Runner` drives one job through clone → install → `fabrika-cloudflare-executor deploy`, narrating progress and
// streaming child stdout/stderr line-by-line into an in-memory log buffer. Secret values and
// credentials are redacted from every line before it lands in the buffer; they only ever reach
// the `fabrika` child through its environment, never argv, never a log.

import type { RunLogLine } from '@fabrika/control-contract'
import { OPERATIONS_ARTIFACT_HEADERS } from '@fabrika/operations-contract/releases'
import type { CloudflareRunnerJob } from '@fabrika/provider-cloudflare/runner'
import type { RunnerState, RunnerStatus } from '@fabrika/runner-contract'

/**
 * Upper bound on the in-memory log replay buffer. A pathologically chatty build (verbose installs,
 * huge generated output) must not exhaust the container's memory. The relay continuously flushes every
 * line to R2, so once a line is persisted it's safe to drop from the in-memory buffer — only a NEW
 * subscriber's replay is bounded, never the durable R2 log.
 */
const MAX_BUFFER_LINES = 10_000

/** A spawned command's outcome plus its (already line-split, redacted) output. */
export interface SpawnResult {
	exitCode: number
}

/** How the runner observes a child process's output, one decoded chunk at a time. */
export interface SpawnHandlers {
	onStdout: (chunk: string) => void
	onStderr: (chunk: string) => void
}

/** A single command to spawn: argv (never a shell string), cwd, and extra env. */
export interface SpawnSpec {
	command: string
	args: string[]
	cwd: string
	env?: Record<string, string>
}

/** Spawns a child process, streaming its output through `handlers`; resolves with the exit code. */
export type Spawner = (spec: SpawnSpec, handlers: SpawnHandlers) => Promise<SpawnResult>

/** The collaborators a `Runner` needs — substituted by tests, defaulted to a real Bun spawn. */
export interface RunnerEnv {
	/** Spawns child processes (git, bun, fabrika). */
	spawn: Spawner
	/** Absolute base directory clones are made under (one sub-dir per run). */
	workspace: string
	/** Wall clock, injectable for deterministic tests. Defaults to `Date.now`. */
	now?: () => number
	/** Source-map discovery seam; production scans the completed checkout. */
	collectSourceMaps?: (cwd: string) => Promise<SourceMapCollection>
	/** Artifact upload transport. */
	fetch?: ArtifactFetch
}

export type ArtifactFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface SourceMapArtifact {
	logicalPath: string
	digest: string
	body: ArrayBuffer
}

export interface SourceMapCollection {
	artifacts: SourceMapArtifact[]
	incomplete: boolean
}

/** Build the redactor: a function that masks every sensitive value found in a line. */
const makeRedactor = (job: CloudflareRunnerJob): (text: string) => string => {
	const sensitive = new Set<string>()
	for (const value of Object.values(job.credentials)) {
		if (typeof value === 'string' && value.length >= 4) {
			sensitive.add(value)
		}
	}
	for (const value of Object.values(job.secrets ?? {})) {
		if (value.length >= 4) {
			sensitive.add(value)
		}
	}
	for (const value of Object.values(job.vars ?? {})) {
		if (value.length >= 4) {
			sensitive.add(value)
		}
	}
	for (const value of Object.values(job.managedEnvironment ?? {})) {
		if (value.length >= 4) {
			sensitive.add(value)
		}
	}
	if (job.artifactUpload?.bearer !== undefined) sensitive.add(job.artifactUpload.bearer)
	// The clone URL may embed a short-lived installation token as userinfo (`x-access-token:<token>@…`
	// for a private repo); redact it like any other credential so it never lands in a persisted log line.
	try {
		const password = new URL(job.repoUrl).password
		if (password.length >= 4) {
			sensitive.add(password)
		}
	} catch {
		// repoUrl isn't a parseable absolute URL (e.g. a fake/test value) — nothing to extract.
	}
	// Longest-first so a value that contains another is masked before its substring.
	const values = [...sensitive].sort((a, b) => b.length - a.length)
	return (text: string): string => {
		let out = text
		for (const value of values) {
			out = out.split(value).join('***')
		}
		return out
	}
}

/** Strip any `user:pass@` userinfo from a URL for display — the clone URL may carry an install token. */
const stripUserinfo = (url: string): string => url.replace(/(\/\/)[^@/]*@/, '$1')

/**
 * Drives one job to completion. Construct, subscribe to `onLine` (the Worker relays these to R2),
 * then `await run()`. The terminal `status()` carries the provider CLI exit code.
 */
export class Runner {
	private readonly job: CloudflareRunnerJob
	private readonly env: RunnerEnv & { now: () => number; collectSourceMaps: (cwd: string) => Promise<SourceMapCollection>; fetch: ArtifactFetch }
	private readonly redact: (text: string) => string
	private readonly buffer: RunLogLine[] = []
	private readonly subscribers = new Set<(line: RunLogLine) => void>()
	private state: RunnerState = 'pending'
	private exitCode: number | undefined
	private error: string | undefined
	private artifactState: RunnerStatus['artifactState']
	private readonly startedAt: number
	private finishedAt: number | undefined
	private done = false

	constructor(job: CloudflareRunnerJob, env: RunnerEnv) {
		this.job = job
		this.env = {
			now: () => Date.now(),
			collectSourceMaps: collectSourceMaps,
			fetch,
			...env,
		}
		this.redact = makeRedactor(job)
		this.startedAt = this.env.now()
	}

	/** The directory this run's repo is cloned into. */
	get checkoutDir(): string {
		return `${this.env.workspace}/${this.job.runId}`
	}

	/** Append a line (redacted) to the buffer and fan it out to subscribers. */
	private emit(stream: RunLogLine['stream'], rawText: string): void {
		const text = this.redact(rawText)
		const line: RunLogLine = { ts: this.env.now(), stream, text }
		this.buffer.push(line)
		if (this.buffer.length > MAX_BUFFER_LINES) {
			// Drop the oldest 10% in one splice (amortized O(1) per line) — those lines are already in R2.
			this.buffer.splice(0, Math.floor(MAX_BUFFER_LINES * 0.1))
		}
		for (const sub of this.subscribers) {
			sub(line)
		}
	}

	/** Split a streamed chunk into lines and emit each (chunks may contain partial trailing text). */
	private emitChunk(stream: 'stdout' | 'stderr', chunk: string): void {
		for (const line of chunk.split('\n')) {
			if (line.length > 0) {
				this.emit(stream, line)
			}
		}
	}

	/** Subscribe to new log lines. Returns an unsubscribe fn. Replay of the buffer is via `lines()`. */
	subscribe(fn: (line: RunLogLine) => void): () => void {
		this.subscribers.add(fn)
		return () => {
			this.subscribers.delete(fn)
		}
	}

	/** Every line emitted so far (already redacted). */
	lines(): readonly RunLogLine[] {
		return this.buffer
	}

	/** Whether the run has reached a terminal state. */
	isDone(): boolean {
		return this.done
	}

	/** The current (or terminal) status. */
	status(): RunnerStatus {
		return {
			runId: this.job.runId,
			state: this.state,
			...(this.exitCode !== undefined ? { exitCode: this.exitCode } : {}),
			...(this.error !== undefined ? { error: this.error } : {}),
			...(this.artifactState === undefined ? {} : { artifactState: this.artifactState }),
			startedAt: this.startedAt,
			...(this.finishedAt !== undefined ? { finishedAt: this.finishedAt } : {}),
		}
	}

	/** Spawn a step, wiring its output into the log buffer. */
	private async step(spec: SpawnSpec): Promise<SpawnResult> {
		return this.env.spawn(spec, {
			onStdout: (chunk) => this.emitChunk('stdout', chunk),
			onStderr: (chunk) => this.emitChunk('stderr', chunk),
		})
	}

	/** Build the provider CLI environment without putting sensitive values on argv. */
	private deployEnv(): Record<string, string> {
		const env: Record<string, string> = {}
		for (const [key, value] of Object.entries(this.job.credentials)) {
			if (typeof value === 'string' && value.length > 0) {
				env[key] = value
			}
		}
		if (this.job.domain !== undefined) {
			env['FABRIKA_CONTROL_DOMAIN'] = this.job.domain
		}
		if (this.job.stateNamespace !== undefined) {
			env['CLOUDFLARE_STATE_NAMESPACE'] = this.job.stateNamespace
		}
		// Secrets are read by the CLI from the environment by their own name.
		for (const [name, value] of Object.entries(this.job.secrets ?? {})) {
			env[name] = value
		}
		// Non-secret deploy vars: same env-by-name forwarding (the CLI reads pipeline.vars from the env).
		for (const [name, value] of Object.entries(this.job.vars ?? {})) {
			env[name] = value
		}
		// Platform-managed values use the same env transport; only their names are added to argv.
		for (const [name, value] of Object.entries(this.job.managedEnvironment ?? {})) {
			env[name] = value
		}
		return env
	}

	/** Mark the run finished and capture the terminal info. */
	private finish(state: 'succeeded' | 'failed', detail: { exitCode?: number; error?: string } = {}): void {
		this.state = state
		this.exitCode = detail.exitCode
		this.error = detail.error
		this.finishedAt = this.env.now()
		this.done = true
	}

	/**
	 * Run clone → install → provider deploy. Resolves once terminal; failures land in `status()`.
	 */
	async run(): Promise<RunnerStatus> {
		// ── clone ──
		this.state = 'cloning'
		this.emit('meta', `Cloning ${stripUserinfo(this.job.repoUrl)} @ ${this.job.ref}`)
		// `git clone --branch` wants a short branch/tag NAME, not a fully-qualified ref — strip the
		// `refs/heads/` or `refs/tags/` prefix the trigger carries (a bare name/sha passes through).
		const branch = this.job.ref.replace(/^refs\/(heads|tags)\//, '')
		const clone = await this.step({
			command: 'git',
			args: ['clone', '--depth', '1', '--branch', branch, this.job.repoUrl, this.checkoutDir],
			cwd: this.env.workspace,
		})
		if (clone.exitCode !== 0) {
			this.emit('meta', `Clone failed (exit ${clone.exitCode})`)
			this.finish('failed', { error: `git clone failed (exit ${clone.exitCode})` })
			return this.status()
		}

		const dir = this.job.workerDir !== undefined ? `${this.checkoutDir}/${this.job.workerDir}` : this.checkoutDir

		// ── install ──
		this.state = 'installing'
		this.emit('meta', `Installing dependencies in ${dir}`)
		const install = await this.step({ command: 'bun', args: ['install'], cwd: dir })
		if (install.exitCode !== 0) {
			this.emit('meta', `Install failed (exit ${install.exitCode})`)
			this.finish('failed', { error: `bun install failed (exit ${install.exitCode})` })
			return this.status()
		}

		// ── deploy ──
		this.state = 'deploying'
		const deployArgs = ['deploy', `--env=${this.job.env}`]
		if (this.job.configPath !== undefined) {
			deployArgs.push(`--config=${this.job.configPath}`)
		}
		if (this.job.dryRun === true) {
			deployArgs.push('--dry-run')
		}
		for (const name of Object.keys(this.job.managedEnvironment ?? {}).sort()) {
			deployArgs.push(`--managed-var=${name}`)
		}
		this.emit('meta', `Running: fabrika-cloudflare-executor ${deployArgs.join(' ')}`)
		const deploy = await this.step({ command: 'fabrika-cloudflare-executor', args: deployArgs, cwd: dir, env: this.deployEnv() })
		this.emit('meta', `fabrika-cloudflare-executor deploy exited with code ${deploy.exitCode}`)
		if (deploy.exitCode === 0) {
			await this.uploadArtifacts(dir)
		}
		this.finish(deploy.exitCode === 0 ? 'succeeded' : 'failed', { exitCode: deploy.exitCode })
		return this.status()
	}

	private async uploadArtifacts(cwd: string): Promise<void> {
		const destination = this.job.artifactUpload
		if (destination === undefined) return
		if (this.job.dryRun === true) {
			this.artifactState = 'not_applicable'
			return
		}
		try {
			const collection = await this.env.collectSourceMaps(cwd)
			let incomplete = collection.incomplete
			for (const artifact of collection.artifacts) {
				const response = await this.env.fetch(destination.url, {
					method: 'POST',
					headers: {
						authorization: `Bearer ${destination.bearer}`,
						'content-type': 'application/json',
						[OPERATIONS_ARTIFACT_HEADERS.appId]: destination.appId,
						[OPERATIONS_ARTIFACT_HEADERS.environment]: destination.environment,
						[OPERATIONS_ARTIFACT_HEADERS.serviceKey]: destination.serviceKey,
						[OPERATIONS_ARTIFACT_HEADERS.release]: destination.release,
						[OPERATIONS_ARTIFACT_HEADERS.runId]: destination.runId,
						[OPERATIONS_ARTIFACT_HEADERS.logicalPath]: artifact.logicalPath,
						[OPERATIONS_ARTIFACT_HEADERS.digest]: artifact.digest,
					},
					body: artifact.body,
				})
				if (!response.ok) incomplete = true
				await response.body?.cancel().catch(() => {})
			}
			this.artifactState = incomplete ? 'incomplete' : 'complete'
			this.emit('meta', `Operations source maps: ${collection.artifacts.length} uploaded, state=${this.artifactState}`)
		} catch {
			this.artifactState = 'incomplete'
			this.emit('meta', 'Operations source maps: upload incomplete')
		}
	}
}

const MAX_SOURCE_MAP_BYTES = 8 * 1024 * 1024
const MAX_SOURCE_MAPS = 256
const MAX_SOURCE_MAP_TOTAL_BYTES = 64 * 1024 * 1024

export async function collectSourceMaps(cwd: string): Promise<SourceMapCollection> {
	const artifacts: SourceMapArtifact[] = []
	let totalBytes = 0
	let incomplete = false
	const glob = new Bun.Glob('**/*.map')
	for await (const relativePath of glob.scan({ cwd, dot: false, onlyFiles: true })) {
		if (relativePath.split('/').some((part) => part === 'node_modules' || part === '.git')) continue
		if (artifacts.length >= MAX_SOURCE_MAPS) {
			incomplete = true
			break
		}
		const file = Bun.file(`${cwd}/${relativePath}`)
		if (file.size > MAX_SOURCE_MAP_BYTES || totalBytes + file.size > MAX_SOURCE_MAP_TOTAL_BYTES) {
			incomplete = true
			continue
		}
		const body = await file.arrayBuffer()
		const logicalPath = sourceMapLogicalPath(await file.text(), relativePath)
		if (logicalPath === null) {
			incomplete = true
			continue
		}
		totalBytes += file.size
		artifacts.push({ logicalPath, digest: await digest(body), body })
	}
	return { artifacts, incomplete }
}

function sourceMapLogicalPath(raw: string, mapPath: string): string | null {
	let value: unknown
	try {
		value = JSON.parse(raw)
	} catch {
		return null
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
	const file = Reflect.get(value, 'file')
	if (typeof file !== 'string' || file === '') return null
	const explicitlyRooted = file.startsWith('/') || file.startsWith('~/') || URL.canParse(file)
	if (!explicitlyRooted && !file.includes('/') && mapPath.includes('/')) {
		// A nested map with only `file: "app.js"` does not reveal its public build root.
		// Guessing from the filesystem path would reintroduce basename collisions.
		return null
	}
	let path = file
	try {
		path = new URL(file).pathname
	} catch {
		const query = path.indexOf('?')
		if (query !== -1) path = path.slice(0, query)
		const hash = path.indexOf('#')
		if (hash !== -1) path = path.slice(0, hash)
	}
	path = path.replaceAll('\\', '/').replace(/^~?\//, '')
	const parts = path.split('/').filter((part) => part !== '' && part !== '.')
	if (parts.length === 0 || parts.some((part) => part === '..')) return null
	return parts.join('/')
}

async function digest(body: ArrayBuffer): Promise<string> {
	const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', body))
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
