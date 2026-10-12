// The ClamAV scanner of the scan pass, on Bun: one `clamscan` over a batch written to a private temporary directory,
// so the signatures load once per batch. Its limits make every unscannable file an alert rather than a silent pass:
// an encrypted file, one past a size, recursion or time limit, all come back FOUND and are rejected. Signatures older
// than `maxSignatureAgeDays` make clamscan refuse the batch. Only an exact `<path>: OK` line is a clean verdict.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FILE_LIMITS } from '../contract/defaults'
import { type FileScanner, SCAN_LIMITS, type ScanBatchResult, type ScanFailure, type ScanObject, type ScanVerdict } from './scan'

export const CLAMSCAN_LIMITS = {
	/** The scanner refuses signatures older than this; the provider refreshes them at start and daily. */
	maxSignatureAgeDays: 3,
	/** One file's scan time, after which ClamAV alerts instead of passing it. */
	maxScanTimeMs: 120_000,
	maxRecursion: 10,
	maxFilesPerContainer: 1000,
	/** What clamscan may print; past it the run is stopped and the batch gets no verdict. */
	maxOutputBytes: 1024 * 1024,
} as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface ClamscanOptions {
	/** The `clamscan` binary; by default the one on `PATH`. */
	readonly binary?: string
	/** The signature directory; by default ClamAV's configured one. */
	readonly database?: string
	/** Where the batch's directory is made; by default the system's temporary directory. */
	readonly directory?: string
	readonly timeoutMs?: number
	/** The largest file ClamAV reads in full; a larger one alerts. By default `FILE_LIMITS.maxScannedBytes`. */
	readonly maxFileBytes?: number
}

/** The arguments of one run; every limit alerts, so a file ClamAV could not read in full is never reported OK. */
export function clamscanArguments(database: string | undefined, size: number = FILE_LIMITS.maxScannedBytes): readonly string[] {
	return [
		'--no-summary',
		'--stdout',
		'--alert-encrypted=yes',
		'--alert-exceeds-max=yes',
		`--fail-if-cvd-older-than=${CLAMSCAN_LIMITS.maxSignatureAgeDays}`,
		`--max-filesize=${size}`,
		`--max-scansize=${size * 4}`,
		`--max-scantime=${CLAMSCAN_LIMITS.maxScanTimeMs}`,
		`--max-recursion=${CLAMSCAN_LIMITS.maxRecursion}`,
		`--max-files=${CLAMSCAN_LIMITS.maxFilesPerContainer}`,
		...(database === undefined ? [] : [`--database=${database}`]),
	]
}

/**
 * The verdicts of one finished run. Exit 0 (nothing found) and 1 (something found) carry per-file lines; any other exit
 * is a failed batch, classified from stderr. A file without exactly one `<path>: OK` or `<path>: <name> FOUND` line,
 * a conflicting second line included, gets no clean verdict.
 */
export function clamscanVerdicts(paths: ReadonlyMap<string, string>, exitCode: number, stdout: string, stderr: string): ScanBatchResult {
	if (exitCode !== 0 && exitCode !== 1) {
		// `--stdout` moves clamscan's own errors to stdout; libclamav's stay on stderr.
		return { ok: false, failure: failureOf(`${stdout}\n${stderr}`) }
	}
	const verdicts = new Map<string, ScanVerdict>()
	const seen = new Set<string>()
	for (const line of stdout.split('\n')) {
		for (const [id, path] of paths) {
			const prefix = `${path}: `
			if (!line.startsWith(prefix)) {
				continue
			}
			const answer = line.slice(prefix.length)
			const found = /^(\S+) FOUND$/.exec(answer)
			const verdict: ScanVerdict = answer === 'OK'
				? { kind: 'clean' }
				: found?.[1] !== undefined
				? { kind: 'infected', signature: found[1] }
				: { kind: 'unscanned' }
			verdicts.set(id, seen.has(id) ? { kind: 'unscanned' } : verdict)
			seen.add(id)
		}
	}
	return { ok: true, verdicts }
}

function failureOf(output: string): ScanFailure {
	if (output.includes('Virus database is older than')) {
		return 'signatures_stale'
	}
	if (output.includes('cl_load') || output.includes('No supported database files')) {
		return 'signatures_missing'
	}
	return 'scanner_failed'
}

/**
 * The stream's text, or `null` once it passes `limit` bytes (when `overflow` runs) or `halt` aborts: a process the run
 * killed may have left a child holding the pipe open.
 */
async function bounded(stream: ReadableStream<Uint8Array>, limit: number, overflow: () => void, halt: AbortSignal): Promise<string | null> {
	const decoder = new TextDecoder()
	let text = ''
	let length = 0
	const reader = stream.getReader()
	const halted = new Promise<null>((resolve) => halt.addEventListener('abort', () => resolve(null), { once: true }))
	const read = () => Promise.race([reader.read(), halted])
	for (let next = await read(); next !== null && !next.done; next = await read()) {
		length += next.value.byteLength
		if (length > limit) {
			overflow()
			await reader.cancel()
			return null
		}
		text += decoder.decode(next.value, { stream: true })
	}
	if (halt.aborted) {
		await reader.cancel()
		return null
	}
	return text + decoder.decode()
}

/** `promise`'s value, or `null` once `signal` aborts first: a read that never answers does not hold the run. */
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
	if (signal.aborted) return Promise.resolve(null)
	return new Promise((resolve, reject) => {
		const stop = () => resolve(null)
		signal.addEventListener('abort', stop, { once: true })
		promise.then(
			(value) => {
				signal.removeEventListener('abort', stop)
				resolve(value)
			},
			(error: unknown) => {
				signal.removeEventListener('abort', stop)
				reject(error)
			},
		)
	})
}

/**
 * Streams `body` to `path`; `false` when `signal` aborted it, which cancels the reader. A reader and a file sink:
 * `Bun.write` of a stream that errors never settles (Bun 1.3).
 */
async function writeStream(path: string, body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<boolean> {
	const sink = Bun.file(path).writer()
	const reader = body.getReader()
	try {
		for (let next = await unlessAborted(reader.read(), signal); next !== null; next = await unlessAborted(reader.read(), signal)) {
			if (next.done) return true
			sink.write(next.value)
		}
		return false
	} finally {
		await reader.cancel().catch(() => undefined)
		await sink.end()
	}
}

/** Writes each object to `<directory>/<id>`; a file whose object could not be read in full is left out. */
async function write(directory: string, objects: readonly ScanObject[], signal: AbortSignal): Promise<Map<string, string>> {
	const paths = new Map<string, string>()
	for (const object of objects) {
		if (signal.aborted) break
		if (!UUID.test(object.id)) continue
		const path = join(directory, object.id)
		try {
			const body = await unlessAborted(object.open(signal), signal)
			if (body !== null && (await writeStream(path, body, signal))) paths.set(object.id, path)
		} catch {
			await rm(path, { force: true })
		}
	}
	return paths
}

interface Finished {
	readonly exitCode: number
	readonly stdout: string
	readonly stderr: string
}

/** One clamscan run, stopped on `signal` or once its output passes the bound; never started once `signal` aborted. */
async function run(binary: string, args: readonly string[], signal: AbortSignal): Promise<Finished | ScanFailure> {
	if (signal.aborted) return 'timeout'
	let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
	try {
		// Only PATH: the job's own environment carries the application's secrets.
		child = Bun.spawn([binary, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' } })
	} catch {
		return 'scanner_missing'
	}
	let stopped = false
	const halt = new AbortController()
	const stop = (): void => {
		stopped = true
		child.kill('SIGKILL')
		halt.abort()
	}
	signal.addEventListener('abort', stop, { once: true })
	try {
		let overflowed = false
		const overflow = (): void => {
			overflowed = true
			child.kill('SIGKILL')
			halt.abort()
		}
		const [stdout, stderr, exitCode] = await Promise.all([
			bounded(child.stdout, CLAMSCAN_LIMITS.maxOutputBytes, overflow, halt.signal),
			bounded(child.stderr, CLAMSCAN_LIMITS.maxOutputBytes, overflow, halt.signal),
			child.exited,
		])
		if (overflowed) {
			return 'output_overflow'
		}
		if (stopped || stdout === null || stderr === null) {
			return 'timeout'
		}
		return { exitCode, stdout, stderr }
	} finally {
		signal.removeEventListener('abort', stop)
	}
}

/** ClamAV's `clamscan` as the scan pass's scanner. Fails closed: see `ScanFailure` for what makes a batch fail. */
export function clamscanScanner(options: ClamscanOptions = {}): FileScanner {
	const binary = options.binary ?? 'clamscan'
	const timeoutMs = options.timeoutMs ?? SCAN_LIMITS.scanTimeoutMs
	return {
		async scan(objects, signal) {
			// One deadline over the whole run: reading the objects, writing them, the scan and the cleanup.
			const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
			const directory = await mkdtemp(join(options.directory ?? tmpdir(), 'fabrika-scan-'))
			try {
				const paths = await write(directory, objects, deadline)
				if (deadline.aborted) {
					return { ok: false, failure: 'timeout' }
				}
				if (paths.size === 0) {
					return { ok: true, verdicts: new Map() }
				}
				const args = [...clamscanArguments(options.database, options.maxFileBytes), ...paths.values()]
				const finished = await run(binary, args, deadline)
				return typeof finished === 'string'
					? { ok: false, failure: finished }
					: clamscanVerdicts(paths, finished.exitCode, finished.stdout, finished.stderr)
			} finally {
				await rm(directory, { recursive: true, force: true })
			}
		},
	}
}
