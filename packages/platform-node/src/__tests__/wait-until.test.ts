// The whole point of this port on a long-running process is that a background failure must NEVER take
// the process down. These tests assert that directly: a rejected promise handed to `waitUntil` is
// reported and dropped, `drain()` still settles, and even a reporter that itself throws cannot
// resurrect the failure.

import { describe, expect, test } from 'bun:test'
import { createBackgroundTasks } from '../wait-until'

describe('createBackgroundTasks', () => {
	test('runs the work and drains it', async () => {
		const seen: string[] = []
		const tasks = createBackgroundTasks()
		tasks.waitUntil(
			Promise.resolve().then(() => {
				seen.push('done')
			}),
		)
		expect(tasks.pending).toBe(1)
		await tasks.drain()
		expect(seen).toEqual(['done'])
		expect(tasks.pending).toBe(0)
	})

	test('swallows a rejection and reports it', async () => {
		const errors: unknown[] = []
		const tasks = createBackgroundTasks({ onError: (error) => errors.push(error) })
		tasks.waitUntil(Promise.reject(new Error('background boom')))
		await tasks.drain()
		expect(errors).toHaveLength(1)
		expect(errors[0]).toBeInstanceOf(Error)
	})

	test('drain() resolves rather than rejecting when work failed', async () => {
		const tasks = createBackgroundTasks({ onError: () => {} })
		tasks.waitUntil(Promise.reject(new Error('boom')))
		// Would throw here if the rejection propagated — which is exactly the outage this port prevents.
		await tasks.drain()
		expect(tasks.pending).toBe(0)
	})

	test('one failure does not stop the other tasks', async () => {
		const done: number[] = []
		const tasks = createBackgroundTasks({ onError: () => {} })
		tasks.waitUntil(Promise.reject(new Error('boom')))
		tasks.waitUntil(
			Promise.resolve().then(() => {
				done.push(1)
			}),
		)
		tasks.waitUntil(
			Promise.resolve().then(() => {
				done.push(2)
			}),
		)
		await tasks.drain()
		expect(done.sort()).toEqual([1, 2])
	})

	test('a throwing error reporter is itself contained', async () => {
		const tasks = createBackgroundTasks({
			onError: () => {
				throw new Error('the reporter is broken too')
			},
		})
		tasks.waitUntil(Promise.reject(new Error('boom')))
		await tasks.drain()
		expect(tasks.pending).toBe(0)
	})

	test('drain() waits for work enqueued by work already draining', async () => {
		const seen: string[] = []
		const tasks = createBackgroundTasks()
		tasks.waitUntil(
			Promise.resolve().then(() => {
				seen.push('outer')
				tasks.waitUntil(
					Promise.resolve().then(() => {
						seen.push('inner')
					}),
				)
			}),
		)
		await tasks.drain()
		expect(seen).toEqual(['outer', 'inner'])
	})

	test('drain() on an idle supervisor is a no-op', async () => {
		const tasks = createBackgroundTasks()
		await tasks.drain()
		expect(tasks.pending).toBe(0)
	})

	test('pending drops back to zero once slow work finishes', async () => {
		const tasks = createBackgroundTasks()
		tasks.waitUntil(Bun.sleep(5))
		expect(tasks.pending).toBe(1)
		await tasks.drain()
		expect(tasks.pending).toBe(0)
	})
})
