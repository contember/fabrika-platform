import { describe, expect, test } from 'bun:test'
import { HttpOperationsService } from '../node/operations'

describe('node Operations transport', () => {
	test('rejects a stalled private request after the configured timeout', async () => {
		let release: (() => void) | undefined
		const stalled = new Promise<void>((resolve) => {
			release = resolve
		})
		let received = false
		const server = Bun.serve({
			port: 0,
			async fetch() {
				received = true
				await stalled
				return Response.json({ ok: true })
			},
		})
		try {
			const service = new HttpOperationsService(`http://127.0.0.1:${server.port}`, 20)
			const startedAt = performance.now()
			let rejected = false
			try {
				await service.fetch(new Request('http://control.localhost/api/rpc'))
			} catch {
				rejected = true
			}

			expect(received).toBe(true)
			expect(rejected).toBe(true)
			expect(performance.now() - startedAt).toBeLessThan(1_000)
		} finally {
			release?.()
			await server.stop(true)
		}
	})
})
