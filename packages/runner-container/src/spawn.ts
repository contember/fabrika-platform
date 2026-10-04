// The real `Spawner`: runs a child via Bun, decoding stdout/stderr and streaming each chunk to the
// caller as it arrives. No shell — argv is passed verbatim — so nothing the job carries can be
// interpreted as a shell metacharacter. The child's env is the runner's env plus the spec's extras
// (creds + secret values for the `fabrika` child).

import type { Spawner, SpawnHandlers, SpawnResult, SpawnSpec } from './runner'

/** Pump a readable byte stream, decoding to text and handing each chunk to `onChunk`. */
const pump = async (stream: ReadableStream<Uint8Array>, onChunk: (text: string) => void, signal: AbortSignal): Promise<void> => {
	const decoder = new TextDecoder()
	const reader = stream.getReader()
	let cancellation: Promise<void> | undefined
	const cancel = (): void => {
		cancellation = reader.cancel().catch(() => {})
	}
	signal.addEventListener('abort', cancel, { once: true })
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) {
				break
			}
			if (value !== undefined) {
				onChunk(decoder.decode(value, { stream: true }))
			}
		}
		const tail = decoder.decode()
		if (!signal.aborted && tail.length > 0) {
			onChunk(tail)
		}
	} finally {
		signal.removeEventListener('abort', cancel)
		await cancellation
		reader.releaseLock()
	}
}

interface PipedChild {
	stdout: ReadableStream<Uint8Array>
	stderr: ReadableStream<Uint8Array>
	exited: Promise<number>
	kill: (signal: 'SIGKILL') => void
}

/** The child seam keeps pipe and termination failures testable without running a deployment. */
export const createSpawner =
	(spawnChild: (spec: SpawnSpec) => PipedChild): Spawner => async (spec: SpawnSpec, handlers: SpawnHandlers): Promise<SpawnResult> => {
		const proc = spawnChild(spec)
		const abort = new AbortController()
		const stdout = pump(proc.stdout, handlers.onStdout, abort.signal)
		const stderr = pump(proc.stderr, handlers.onStderr, abort.signal)
		const work = [stdout, stderr, proc.exited]
		try {
			const [, , exitCode] = await Promise.all([stdout, stderr, proc.exited])
			return { exitCode }
		} catch (error) {
			try {
				proc.kill('SIGKILL')
			} catch {
				// If termination fails, keep the run excluded until the child actually exits.
			}
			abort.abort()
			await Promise.allSettled(work)
			await Promise.allSettled([proc.stdout.cancel(), proc.stderr.cancel()])
			throw error
		}
	}

/** Default spawner: a real Bun child process with piped, streamed stdout/stderr. */
export const bunSpawner: Spawner = createSpawner((spec) =>
	Bun.spawn([spec.command, ...spec.args], {
		cwd: spec.cwd,
		env: { ...process.env, ...spec.env },
		stdout: 'pipe',
		stderr: 'pipe',
	})
)
