import { describe, expect, test } from 'bun:test'
import { iamProvisioningClient } from '../iam-provisioning'

describe('iamProvisioningClient', () => {
	test.each([307, 308])('a %d is not followed: the provisioning key and the input never reach the target', async (status) => {
		const arrivals: string[] = []
		const target = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch: async (request) => {
				arrivals.push(await request.text())
				return Response.json({ result: { items: [] } })
			},
		})
		// `localhost` against `127.0.0.1`: the same machine, another origin.
		const location = `http://localhost:${target.port}/collect`
		const iam = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(null, { status, headers: { location } }) })
		try {
			const client = iamProvisioningClient({ origin: `http://127.0.0.1:${iam.port}`, provisioningKey: 'px_provisioning' })
			await expect(client.principals.list({ type: 'user', limit: 1 })).rejects.toThrow()
			expect(arrivals).toEqual([])
		} finally {
			await iam.stop(true)
			await target.stop(true)
		}
	})
})
