import { describe, expect, test } from 'bun:test'
import { RemoteReviewBackend } from './review-remote'

describe('remote review backend', () => {
	test.each([307, 308])('a %d from the share worker is not followed, so the agent token stays put', async (status) => {
		const arrivals: string[] = []
		const target = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch: (request) => {
				arrivals.push(request.url)
				return Response.json({ threads: [] })
			},
		})
		// `localhost` against `127.0.0.1`: the same machine, another origin.
		const location = `http://localhost:${target.port}/collect`
		const worker = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(null, { status, headers: { location } }) })
		try {
			const backend = new RemoteReviewBackend('notes', {
				endpoint: `http://127.0.0.1:${worker.port}`,
				projectId: 'a'.repeat(24),
				key: 'unused',
				agentToken: 'agent-token',
				appUrl: 'https://notes.example.com',
			})
			await expect(backend.threads()).rejects.toThrow(`The share worker answered ${status}`)
			expect(arrivals).toEqual([])
		} finally {
			await worker.stop(true)
			await target.stop(true)
		}
	})
})
