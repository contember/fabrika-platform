// The in-container run engine — pure of HTTP, so it's unit-testable with a fake command runner.
//
// A `Runner` drives one job through verified checkout → install → `fabrika-cloudflare-executor deploy`, narrating progress and
// streaming child stdout/stderr line-by-line into an in-memory log buffer. Secret values and
// credentials are redacted from every line before it lands in the buffer; they only ever reach
// the `fabrika` child through its environment, never argv, never a log.

import type { RunLogLine } from '@fabrika/control-contract'
import { OPERATIONS_ARTIFACT_HEADERS } from '@fabrika/operations-contract/releases'
import type { CloudflareRunnerJob } from '@fabrika/provider-cloudflare/runner'
import {
	RUNNER_OUTCOME_FILE_ENV,
	type RunnerIamReconcile,
	type RunnerOutcomeFile,
	type RunnerState,
	type RunnerStatus,
} from '@fabrika/runner-contract'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'

/**
 * Upper bound on the in-memory log replay buffer. A pathologically chatty build (verbose installs,
 * huge generated output) must not exhaust the container's memory. The relay continuously flushes every
 * line to R2, so once a line is persisted it's safe to drop from the in-memory buffer — only a NEW
 * subscriber's replay is bounded, never the durable R2 log.
 */
const MAX_BUFFER_LINES = 10_000

const MAX_RESIDUAL_CHARS = 64 * 1024
const MAX_HEAD_BYTES = 128
const COMMIT_SHA = /^[0-9a-f]{40}$/

const MAX_OUTCOME_FILE_BYTES = 1024 * 1024

const OUTCOME_UNREADABLE = 'runner outcome file is unreadable'
const OUTCOME_TOO_LARGE = 'runner outcome file exceeds the size limit'
const OUTCOME_MALFORMED = 'runner outcome file is malformed'
const UNEXPECTED_FAILURE = 'runner execution failed unexpectedly'
const HEAD_FAILED = 'git HEAD verification failed'
const HEAD_TOO_LARGE = 'git HEAD output exceeds the size limit'
const HEAD_MALFORMED = 'git HEAD output is malformed'

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

/** Streams child output; settles only after the child stops and both output pumps finish, including on rejection. */
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

interface GitSource {
	url: string
	env: Record<string, string>
	sensitive: string[]
}

const parseGitSource = (repoUrl: string): GitSource | null => {
	try {
		const url = new URL(repoUrl)
		if (url.protocol !== 'https:') return null
		const sensitive: string[] = []
		if (url.username !== '' || url.password !== '') {
			const username = decodeURIComponent(url.username)
			const password = decodeURIComponent(url.password)
			const userinfo = `${username}:${password}`
			const basic = Buffer.from(userinfo).toString('base64')
			const header = `Authorization: Basic ${basic}`
			sensitive.push(
				repoUrl,
				url.href,
				decodeURIComponent(repoUrl),
				url.username,
				url.password,
				username,
				password,
				encodeURIComponent(username),
				encodeURIComponent(password),
				userinfo,
				basic,
				`Basic ${basic}`,
				header,
			)
			url.username = ''
			url.password = ''
			return {
				url: url.href,
				sensitive,
				env: {
					GIT_TERMINAL_PROMPT: '0',
					GIT_CONFIG_COUNT: '1',
					GIT_CONFIG_KEY_0: `http.${url.href}.extraHeader`,
					GIT_CONFIG_VALUE_0: header,
				},
			}
		}
		return { url: url.href, env: { GIT_TERMINAL_PROMPT: '0' }, sensitive }
	} catch {
		return null
	}
}

interface Redactor {
	redact: (text: string) => string
	prefixLength: (text: string) => number
}

const makeRedactor = (job: CloudflareRunnerJob, gitSource: GitSource | null): Redactor => {
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
	for (const value of gitSource?.sensitive ?? []) {
		if (value !== '') sensitive.add(value)
	}
	// Longest-first so a value that contains another is masked before its substring.
	const values = [...sensitive].filter((value) => value !== '').sort((a, b) => b.length - a.length)
	const overlap = Math.max(0, (values[0]?.length ?? 1) - 1)
	const matchesIn = (text: string) => {
		const occurrences = values.map((value) => ({ value, index: text.indexOf(value) }))
		return (start: number): { index: number; length: number } | undefined => {
			let match: { index: number; length: number } | undefined
			for (const occurrence of occurrences) {
				if (occurrence.index !== -1 && occurrence.index < start) occurrence.index = text.indexOf(occurrence.value, start)
				if (occurrence.index !== -1 && (match === undefined || occurrence.index < match.index)) {
					match = { index: occurrence.index, length: occurrence.value.length }
				}
				if (occurrence.index === start) break
			}
			return match
		}
	}
	return {
		redact: (text) => {
			const nextMatch = matchesIn(text)
			let out = ''
			let cursor = 0
			for (let match = nextMatch(cursor); match !== undefined; match = nextMatch(cursor)) {
				out += `${text.slice(cursor, match.index)}***`
				cursor = match.index + match.length
			}
			return out + text.slice(cursor)
		},
		prefixLength: (text) => {
			const nextMatch = matchesIn(text)
			let end = Math.max(0, text.length - overlap)
			let cursor = 0
			for (let match = nextMatch(cursor); match !== undefined && match.index < end; match = nextMatch(cursor)) {
				if (match.index + match.length > end) {
					end = match.index
					break
				}
				cursor = match.index + match.length
			}
			return end
		},
	}
}

/** Resolve a job-supplied path under `base`, or `null` if it is absolute, walks up, or escapes. */
const containedPath = (base: string, value: string | undefined): string | null => {
	const root = resolve(base)
	if (value === undefined) return root
	if (value.startsWith('/') || value.split('/').includes('..')) return null
	const resolved = resolve(root, value)
	return resolved === root || resolved.startsWith(`${root}/`) ? resolved : null
}

/** Only our own fixed strings describe an outcome failure — a raw system error may quote a path or content. */
const outcomeFailure = (err: unknown): string => {
	const message = err instanceof Error ? err.message : ''
	return message === OUTCOME_TOO_LARGE || message === OUTCOME_MALFORMED ? message : OUTCOME_UNREADABLE
}

const isFileNotFound = (err: unknown): boolean => typeof err === 'object' && err !== null && Reflect.get(err, 'code') === 'ENOENT'

/** Validate the executor's outcome report; every rejection message quotes nothing from the file. */
const outcomeFileSchema = z.object({
	iamReconcile: z.object({ app: z.string().min(1), schemaJson: z.string().max(MAX_OUTCOME_FILE_BYTES) }).optional(),
})

const parseOutcomeFile = (raw: string): RunnerOutcomeFile => {
	let value: unknown
	try {
		value = JSON.parse(raw)
	} catch {
		throw new Error(OUTCOME_MALFORMED)
	}
	const parsed = outcomeFileSchema.safeParse(value)
	if (!parsed.success) throw new Error(OUTCOME_MALFORMED)
	return parsed.data
}

/**
 * Drives one job to completion. Construct, subscribe to `onLine` (the Worker relays these to R2),
 * then `await run()`. The terminal `status()` carries the provider CLI exit code.
 */
export class Runner {
	private readonly job: CloudflareRunnerJob
	private readonly env: RunnerEnv & { now: () => number; collectSourceMaps: (cwd: string) => Promise<SourceMapCollection>; fetch: ArtifactFetch }
	private readonly gitSource: GitSource | null
	private readonly redactor: Redactor
	private readonly buffer: RunLogLine[] = []
	private readonly subscribers = new Set<(line: RunLogLine) => void>()
	private readonly residual: { stdout: string; stderr: string } = { stdout: '', stderr: '' }
	private readonly discarded: { stdout: boolean; stderr: boolean } = { stdout: false, stderr: false }
	private state: RunnerState = 'pending'
	private exitCode: number | undefined
	private error: string | undefined
	private artifactState: RunnerStatus['artifactState']
	private iamReconcile: RunnerIamReconcile | undefined
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
		this.gitSource = parseGitSource(job.repoUrl)
		this.redactor = makeRedactor(job, this.gitSource)
		this.startedAt = this.env.now()
	}

	/** The directory this run's repo is cloned into. */
	get checkoutDir(): string {
		return `${this.env.workspace}/${this.job.runId}`
	}

	/** Where the executor reports its outcome — beside the checkout, never inside it. */
	get outcomeFilePath(): string {
		return `${this.env.workspace}/${this.job.runId}.outcome.json`
	}

	/** Append a line (redacted) to the buffer and fan it out to subscribers. */
	private emit(stream: RunLogLine['stream'], rawText: string): void {
		const text = this.redactor.redact(rawText)
		const line: RunLogLine = { ts: this.env.now(), stream, text }
		this.buffer.push(line)
		if (this.buffer.length > MAX_BUFFER_LINES) {
			// Drop the oldest 10% in one splice (amortized O(1) per line) — those lines are already in R2.
			this.buffer.splice(0, Math.floor(MAX_BUFFER_LINES * 0.1))
		}
		let observerFailed = false
		for (const sub of this.subscribers) {
			try {
				sub(line)
			} catch {
				observerFailed = true
			}
		}
		if (observerFailed) throw new Error(UNEXPECTED_FAILURE)
	}

	/**
	 * Assemble lines across chunk boundaries before emitting: a pipe read may cut a credential in
	 * half, and the redactor only recognises a value it sees whole.
	 */
	private emitChunk(stream: 'stdout' | 'stderr', chunk: string): void {
		if (this.discarded[stream]) {
			const newline = chunk.indexOf('\n')
			if (newline === -1) return
			this.discarded[stream] = false
			chunk = chunk.slice(newline + 1)
		}
		let pending = this.residual[stream] + chunk
		for (let newline = pending.indexOf('\n'); newline !== -1; newline = pending.indexOf('\n')) {
			const line = pending.slice(0, newline)
			if (line.length > 0) {
				this.emit(stream, line)
			}
			pending = pending.slice(newline + 1)
		}
		if (pending.length > MAX_RESIDUAL_CHARS) {
			// Keep enough original suffix to recognize a credential completed by the next pipe read.
			const end = this.redactor.prefixLength(pending)
			if (end > 0) this.emit(stream, pending.slice(0, end))
			pending = pending.slice(end)
			if (pending.length > MAX_RESIDUAL_CHARS) {
				this.emit(stream, '*** [unfinished log line exceeds the size limit]')
				pending = ''
				this.discarded[stream] = true
			}
		}
		this.residual[stream] = pending
	}

	/** Emit whatever a child left without a trailing newline; residuals never cross processes. */
	private flushResiduals(): void {
		this.flushResidual('stdout')
		this.flushResidual('stderr')
	}

	private flushResidual(stream: 'stdout' | 'stderr'): void {
		const pending = this.residual[stream]
		this.residual[stream] = ''
		this.discarded[stream] = false
		if (pending.length > 0) {
			this.emit(stream, pending)
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
			...(this.iamReconcile === undefined ? {} : { iamReconcile: this.iamReconcile }),
			startedAt: this.startedAt,
			...(this.finishedAt !== undefined ? { finishedAt: this.finishedAt } : {}),
		}
	}

	/** Spawn a step, wiring its output into the log buffer. */
	private async step(spec: SpawnSpec, handlers: SpawnHandlers = {
		onStdout: (chunk) => this.emitChunk('stdout', chunk),
		onStderr: (chunk) => this.emitChunk('stderr', chunk),
	}): Promise<SpawnResult> {
		try {
			return await this.env.spawn(spec, handlers)
		} finally {
			this.flushResiduals()
		}
	}

	private async verifyCheckout(git: GitSource, expected: string): Promise<RunnerStatus | undefined> {
		let head = ''
		let bytes = 0
		let overflowed = false
		let result: SpawnResult
		try {
			result = await this.step({ command: 'git', args: ['log', '-1', '--format=%H', '--'], cwd: this.checkoutDir, env: git.env }, {
				onStdout: (chunk) => {
					bytes += Buffer.byteLength(chunk)
					if (bytes > MAX_HEAD_BYTES) {
						overflowed = true
						throw new Error(HEAD_TOO_LARGE)
					}
					head += chunk
				},
				onStderr: () => {},
			})
		} catch {
			return this.refuse(overflowed ? HEAD_TOO_LARGE : HEAD_FAILED)
		}
		if (result.exitCode !== 0) return this.refuse(HEAD_FAILED)
		if (!/^[0-9a-f]{40}\r?\n$/.test(head)) return this.refuse(HEAD_MALFORMED)
		const actual = head.slice(0, 40)
		if (actual !== expected) return this.refuse('git checkout HEAD does not match the expected commit')
		this.emit('meta', `Git checkout verified: expected=${expected} actual=${actual}`)
		return undefined
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
		// The control plane's projection of where IAM may hand this app a session (ADR-0022). Not a
		// secret — it is public addressing — but it travels the same env transport as everything else.
		if (this.job.returnOrigins !== undefined && this.job.returnOrigins.length > 0) {
			env['FABRIKA_IAM_RETURN_ORIGINS'] = this.job.returnOrigins.join(',')
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
		// Last, so no job-supplied name can redirect where the executor reports its outcome.
		env[RUNNER_OUTCOME_FILE_ENV] = this.outcomeFilePath
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
		try {
			return await this.execute()
		} catch {
			this.finish('failed', { error: UNEXPECTED_FAILURE })
			try {
				this.emit('meta', UNEXPECTED_FAILURE)
			} catch {
				// A failed observer must not prevent terminal status or log-stream completion.
			}
			return this.status()
		}
	}

	private async execute(): Promise<RunnerStatus> {
		// Both the checkout and the outcome file are named after the runId; keep them one path segment.
		if (!/^[A-Za-z0-9-]+$/.test(this.job.runId)) {
			return this.refuse('runId must contain only letters, digits and dashes')
		}
		const dir = containedPath(this.checkoutDir, this.job.workerDir)
		if (dir === null) {
			return this.refuse('workerDir must be a relative path inside the checkout')
		}
		if (containedPath(dir, this.job.configPath) === null) {
			return this.refuse('configPath must be a relative path inside the checkout')
		}

		if (!COMMIT_SHA.test(this.job.ref) && this.job.dryRun !== true) return this.refuse('non-dry ref must be a complete lowercase 40-hex commit SHA')
		const expected = this.job.ref.toLowerCase()
		const exact = COMMIT_SHA.test(expected)
		if (/^[0-9a-f]{64}$/i.test(this.job.ref)) return this.refuse('unsupported commit SHA format')
		const git = this.gitSource
		if (git === null) return this.refuse('repository URL is invalid')
		this.state = 'cloning'
		if (exact) {
			try {
				// mkdir is exclusive: never admit bytes left by an earlier execution with this run ID.
				await mkdir(this.checkoutDir)
			} catch (error) {
				const exists = typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'EEXIST'
				return this.refuse(exists ? 'checkout directory already exists' : 'could not create a fresh checkout directory')
			}
			this.emit('meta', `Checking out ${git.url} @ ${expected}`)
			const steps: SpawnSpec[] = [
				{ command: 'git', args: ['init', '--', this.checkoutDir], cwd: this.env.workspace, env: git.env },
				{ command: 'git', args: ['fetch', '--depth=1', '--no-tags', '--', git.url, expected], cwd: this.checkoutDir, env: git.env },
				{ command: 'git', args: ['switch', '--detach', '--', expected], cwd: this.checkoutDir, env: git.env },
			]
			for (const spec of steps) {
				const result = await this.step(spec)
				if (result.exitCode !== 0) return this.refuse(`git ${spec.args[0]} failed (exit ${result.exitCode})`)
			}
			const failure = await this.verifyCheckout(git, expected)
			if (failure !== undefined) return failure
		} else {
			this.emit('meta', `Cloning ${git.url} @ ${this.job.ref}`)
			const branch = this.job.ref.replace(/^refs\/(heads|tags)\//, '')
			const clone = await this.step({
				command: 'git',
				args: ['clone', '--depth', '1', '--branch', branch, '--', git.url, this.checkoutDir],
				cwd: this.env.workspace,
				env: git.env,
			})
			if (clone.exitCode !== 0) return this.refuse(`git clone failed (exit ${clone.exitCode})`)
		}

		// ── install ──
		this.state = 'installing'
		this.emit('meta', `Installing dependencies in ${dir}`)
		const install = await this.step({ command: 'bun', args: ['install'], cwd: dir })
		if (install.exitCode !== 0) {
			this.finish('failed', { error: `bun install failed (exit ${install.exitCode})` })
			this.emit('meta', `Install failed (exit ${install.exitCode})`)
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
		if (!(await this.clearOutcomeFile())) {
			return this.refuse('could not clear the runner outcome file')
		}
		let deploy: SpawnResult
		let outcome: RunnerOutcomeFile | undefined
		try {
			deploy = await this.step({ command: 'fabrika-cloudflare-executor', args: deployArgs, cwd: dir, env: this.deployEnv() })
			this.emit('meta', `fabrika-cloudflare-executor deploy exited with code ${deploy.exitCode}`)
			try {
				if (deploy.exitCode === 0) outcome = await this.readOutcomeFile()
			} catch (err) {
				const message = outcomeFailure(err)
				this.finish('failed', { exitCode: deploy.exitCode, error: message })
				this.emit('meta', message)
				return this.status()
			}
		} finally {
			await this.clearOutcomeFile()
		}
		if (deploy.exitCode === 0) {
			this.iamReconcile = outcome?.iamReconcile
			await this.uploadArtifacts(dir)
		}
		this.finish(deploy.exitCode === 0 ? 'succeeded' : 'failed', { exitCode: deploy.exitCode })
		return this.status()
	}

	/** Refuse the job before (or instead of) further work; nothing has been recorded but the reason. */
	private refuse(reason: string): RunnerStatus {
		this.finish('failed', { error: reason })
		this.emit('meta', reason)
		return this.status()
	}

	private async clearOutcomeFile(): Promise<boolean> {
		try {
			await rm(this.outcomeFilePath, { force: true })
			return true
		} catch {
			return false
		}
	}

	/** Read what the executor reported; absent means no reconcile, anything else unusable throws a fixed message. */
	private async readOutcomeFile(): Promise<RunnerOutcomeFile | undefined> {
		try {
			const info = await stat(this.outcomeFilePath)
			// A fifo the build left at this path would report size 0 and then block or read unbounded.
			if (!info.isFile()) throw new Error(OUTCOME_UNREADABLE)
			if (info.size > MAX_OUTCOME_FILE_BYTES) throw new Error(OUTCOME_TOO_LARGE)
			return parseOutcomeFile(await readFile(this.outcomeFilePath, 'utf8'))
		} catch (err) {
			if (isFileNotFound(err)) return undefined
			throw new Error(outcomeFailure(err))
		}
	}

	private async uploadArtifacts(cwd: string): Promise<void> {
		const destination = this.job.artifactUpload
		if (destination === undefined) return
		if (this.job.dryRun === true) {
			this.artifactState = 'not_applicable'
			return
		}
		let uploaded = 0
		try {
			const collection = await this.env.collectSourceMaps(cwd)
			uploaded = collection.artifacts.length
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
		} catch {
			this.artifactState = 'incomplete'
			this.emit('meta', 'Operations source maps: upload incomplete')
			return
		}
		this.emit('meta', `Operations source maps: ${uploaded} uploaded, state=${this.artifactState}`)
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

const sourceMapFileSchema = z.object({ file: z.string().min(1) })

function sourceMapLogicalPath(raw: string, mapPath: string): string | null {
	let value: unknown
	try {
		value = JSON.parse(raw)
	} catch {
		return null
	}
	const parsed = sourceMapFileSchema.safeParse(value)
	if (!parsed.success) return null
	const { file } = parsed.data
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
