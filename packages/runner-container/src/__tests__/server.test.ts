import type { RunLogLine } from '@fabrika/control-contract'
import type { CloudflareRunnerJob } from '@fabrika/provider-cloudflare/runner'
import type { RunnerStatus } from '@fabrika/runner-contract'
import { describe, expect, test } from 'bun:test'
import type { RunnerEnv, SpawnHandlers, SpawnResult, SpawnSpec } from '../runner'
import { createServer } from '../server'
import { createSpawner } from '../spawn'

// Drive the job protocol through the server's request handler — no real socket. Proves POST /run,
// GET /logs (NDJSON), GET /status, and the 409-on-double-run guard.

const job: CloudflareRunnerJob = {
	runId: '0198c4a2-7b31-7e44-9a55-0b1c2d3e4f50',
	repoUrl: 'https://github.com/acme/app.git',
	ref: 'main',
	env: 'stage',
	runnerKey: 'test-runner-key',
	credentials: { CLOUDFLARE_ACCOUNT_ID: 'acc-123456', CLOUDFLARE_API_TOKEN: 'tok-abcdef' },
	secrets: { SAMPLE_API_KEY: 'super-secret-value' },
	dryRun: true,
}

/** Env whose spawner emits one stdout line per step, all succeeding. */
const makeEnv = (): RunnerEnv => ({
	workspace: '/workspace',
	spawn: async (spec: SpawnSpec, handlers: SpawnHandlers): Promise<SpawnResult> => {
		handlers.onStdout(`output from ${spec.command} with tok-abcdef\n`)
		return { exitCode: 0 }
	},
})

const post = (body: unknown): Request =>
	new Request('http://container/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** Wait until the active run reaches a terminal state. */
const waitTerminal = async (server: ReturnType<typeof createServer>): Promise<void> => {
	for (let i = 0; i < 100; i++) {
		const runner = server.current()
		if (runner?.isDone()) {
			return
		}
		await new Promise((r) => setTimeout(r, 5))
	}
	throw new Error('run did not terminate')
}

describe('runner server protocol', () => {
	test('the active run owns the parsed job rather than the mutable request object', async () => {
		const gate = Promise.withResolvers<SpawnResult>()
		const server = createServer({ workspace: '/workspace', spawn: () => gate.promise })
		const input = { ...job }
		const request = Object.assign(post(job), { json: async () => input })
		expect((await server.handle(request)).status).toBe(202)
		input.runId = 'mutated-after-admission'
		expect(server.current()?.status().runId).toBe(job.runId)
		gate.resolve({ exitCode: 1 })
		await waitTerminal(server)
	})
	test('POST /run accepts a job (202) and starts it', async () => {
		const server = createServer(makeEnv())
		const response = await server.handle(post(job))
		expect(response.status).toBe(202)
		const body: { runId: string; accepted: boolean } = await response.json()
		expect(body).toEqual({ runId: '0198c4a2-7b31-7e44-9a55-0b1c2d3e4f50', accepted: true })
		expect(server.current()).toBeDefined()
	})

	test('POST /run with invalid body → 400', async () => {
		const server = createServer(makeEnv())
		const response = await server.handle(post({ not: 'a job' }))
		expect(response.status).toBe(400)
	})

	test('a legacy mutable non-dry job is refused before creating a runner or spawning Git', async () => {
		const commands: string[] = []
		const server = createServer({
			workspace: '/workspace',
			spawn: async (spec) => {
				commands.push(spec.command)
				return { exitCode: 0 }
			},
		})
		expect((await server.handle(post({ ...job, dryRun: false }))).status).toBe(400)
		expect(server.current()).toBeUndefined()
		expect(commands).toEqual([])
	})

	test('a second concurrent /run → 409', async () => {
		const server = createServer({
			workspace: '/workspace',
			// A spawner that never resolves the first step keeps the run in-flight.
			spawn: () => new Promise<SpawnResult>(() => {}),
		})
		expect((await server.handle(post(job))).status).toBe(202)
		expect((await server.handle(post(job))).status).toBe(409)
	})

	test('a rejected spawn closes live /logs even when the error observer throws', async () => {
		const failure = Promise.withResolvers<SpawnResult>()
		const server = createServer({ workspace: '/workspace', spawn: () => failure.promise })
		await server.handle(post(job))
		let observedTerminal = false
		server.current()?.subscribe((line) => {
			if (line.text === 'runner execution failed unexpectedly') {
				observedTerminal = server.current()?.isDone() === true
				throw new Error('observer contains super-secret-value')
			}
		})
		const logs = await server.handle(new Request('http://container/logs'))
		const text = logs.text()
		failure.reject(new Error('spawn failed https://x-access-token:unknown-private-token@host/app tok-abcdef'))
		await waitTerminal(server)
		const status: RunnerStatus = await (await server.handle(new Request('http://container/status'))).json()
		expect(status.state).toBe('failed')
		expect(status.error).toBe('runner execution failed unexpectedly')
		expect(typeof status.finishedAt).toBe('number')
		expect(observedTerminal).toBe(true)
		const finishedLogs = await text
		expect(finishedLogs).toContain('runner execution failed unexpectedly')
		for (const sensitive of ['super-secret-value', 'unknown-private-token', 'tok-abcdef']) {
			expect(JSON.stringify(status) + finishedLogs).not.toContain(sensitive)
		}
		expect((await server.handle(post({ ...job, runId: '0198c4a2-7b31-7e44-9a55-0b1c2d3e4f51' }))).status).toBe(202)
		await waitTerminal(server)
	})

	test('failed termination keeps /run excluded until the child exits and its pumps finish', async () => {
		const exit = Promise.withResolvers<number>()
		const cancellation = Promise.withResolvers<void>()
		let failPipe: (() => void) | undefined
		let killAttempted = false
		let children = 0
		const spawn = createSpawner(() => {
			children++
			if (children > 1) {
				return {
					stdout: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
					stderr: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
					exited: Promise.resolve(0),
					kill: () => {},
				}
			}
			return {
				stdout: new ReadableStream<Uint8Array>({
					start(controller) {
						failPipe = () => controller.error(new Error('pipe error tok-abcdef'))
					},
				}),
				stderr: new ReadableStream<Uint8Array>({ cancel: () => cancellation.promise }),
				exited: exit.promise,
				kill() {
					killAttempted = true
					throw new Error('cannot kill child super-secret-value')
				},
			}
		})
		const server = createServer({ workspace: '/workspace', spawn })
		await server.handle(post(job))
		const text = (await server.handle(new Request('http://container/logs'))).text()
		if (failPipe === undefined) throw new Error('child pipe not initialized')
		failPipe()
		await Bun.sleep(10)
		expect(killAttempted).toBe(true)
		expect(server.current()?.isDone()).toBe(false)
		expect((await server.handle(post({ ...job, runId: '0198c4a2-7b31-7e44-9a55-0b1c2d3e4f51' }))).status).toBe(409)
		expect(children).toBe(1)
		exit.resolve(137)
		await Bun.sleep(10)
		expect(server.current()?.isDone()).toBe(false)
		expect((await server.handle(post({ ...job, runId: '0198c4a2-7b31-7e44-9a55-0b1c2d3e4f51' }))).status).toBe(409)
		cancellation.resolve()
		await waitTerminal(server)
		expect(server.current()?.status().error).toBe('runner execution failed unexpectedly')
		expect(await text).toContain('runner execution failed unexpectedly')
		expect((await server.handle(post({ ...job, runId: '0198c4a2-7b31-7e44-9a55-0b1c2d3e4f51' }))).status).toBe(202)
		await waitTerminal(server)
		expect(server.current()?.status().state).toBe('succeeded')
	})

	test('GET /status reports terminal succeeded + exit 0', async () => {
		const server = createServer(makeEnv())
		await server.handle(post(job))
		await waitTerminal(server)
		const status: RunnerStatus = await (await server.handle(new Request('http://container/status'))).json()
		expect(status.state).toBe('succeeded')
		expect(status.exitCode).toBe(0)
		expect(status.runId).toBe('0198c4a2-7b31-7e44-9a55-0b1c2d3e4f50')
	})

	test('GET /logs streams redacted NDJSON lines', async () => {
		const server = createServer(makeEnv())
		await server.handle(post(job))
		await waitTerminal(server)
		const text = await (await server.handle(new Request('http://container/logs'))).text()
		const lines = text.split('\n').filter((l) => l.length > 0).map((l) => {
			const line: RunLogLine = JSON.parse(l)
			return line
		})
		expect(lines.length).toBeGreaterThan(0)
		// Secret value never leaks into the log stream.
		expect(text).not.toContain('tok-abcdef')
		// Meta narration is present (clone/install/deploy progress).
		expect(lines.some((l) => l.stream === 'meta')).toBe(true)
	})

	test('GET /health → ok', async () => {
		const server = createServer(makeEnv())
		const response = await server.handle(new Request('http://container/health'))
		expect(response.status).toBe(200)
		const body: unknown = await response.json()
		expect(body).toEqual({ status: 'ok', port: 8080 })
		expect(server.current()).toBeUndefined()
	})

	test('GET /status before any run → 404', async () => {
		const server = createServer(makeEnv())
		expect((await server.handle(new Request('http://container/status'))).status).toBe(404)
	})
})
