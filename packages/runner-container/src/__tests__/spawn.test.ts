import { describe, expect, test } from 'bun:test'
import type { SpawnHandlers, SpawnSpec } from '../runner'
import { bunSpawner, createSpawner } from '../spawn'

const spec: SpawnSpec = { command: process.execPath, args: [], cwd: process.cwd() }
const handlers: SpawnHandlers = { onStdout: () => {}, onStderr: () => {} }

describe('child process failure cleanup', () => {
	test('a missing executable rejects without creating a child', async () => {
		await expect(bunSpawner({ ...spec, command: '/missing-fabrika-runner-executable' }, handlers)).rejects.toBeDefined()
	})

	test('a pipe rejection waits for child exit and cancellation of the other pipe', async () => {
		const failure = new Error('pipe failure with private-token')
		const exit = Promise.withResolvers<number>()
		const cancelled = Promise.withResolvers<void>()
		const events: string[] = []
		const stdout = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.error(failure)
			},
		})
		const stderr = new ReadableStream<Uint8Array>({
			cancel() {
				events.push('stderr cancellation started')
				return cancelled.promise
			},
		})
		const spawn = createSpawner(() => ({
			stdout,
			stderr,
			exited: exit.promise,
			kill(signal) {
				expect(signal).toBe('SIGKILL')
				events.push('kill')
			},
		}))
		const result = spawn(spec, handlers).catch((error: unknown) => {
			events.push('rejected')
			return error
		})
		await Bun.sleep(10)
		expect(events).toEqual(['kill', 'stderr cancellation started'])
		exit.resolve(137)
		await Bun.sleep(10)
		expect(events).not.toContain('rejected')
		cancelled.resolve()
		expect(await result).toBe(failure)
		expect(events.at(-1)).toBe('rejected')
		expect(stdout.locked).toBe(false)
		expect(stderr.locked).toBe(false)
	})

	test('a throwing output handler kills and reaps a real long-running child before rejection', async () => {
		let pid: number | undefined
		const failure = new Error('observer private-token')
		try {
			await expect(bunSpawner({
				...spec,
				args: ['-e', 'console.log(process.pid); console.error("stderr"); setInterval(() => {}, 1000)'],
			}, {
				onStdout(chunk) {
					pid = Number(chunk.trim())
					throw failure
				},
				onStderr: () => {},
			})).rejects.toBe(failure)
			expect(pid).toBeDefined()
			if (pid === undefined) throw new Error('child did not report its pid')
			const childPid = pid
			expect(() => process.kill(childPid, 0)).toThrow()
		} finally {
			if (pid !== undefined) {
				try {
					process.kill(pid, 'SIGKILL')
				} catch {
					// A regression must not leave the test child running.
				}
			}
		}
	})

	test('normal nonzero exits still resolve with the child exit code', async () => {
		const chunks: string[] = []
		const result = await bunSpawner({ ...spec, args: ['-e', 'console.log("output"); process.exit(7)'] }, {
			onStdout: (chunk) => chunks.push(chunk),
			onStderr: () => {},
		})
		expect(result).toEqual({ exitCode: 7 })
		expect(chunks.join('')).toBe('output\n')
	})
})
