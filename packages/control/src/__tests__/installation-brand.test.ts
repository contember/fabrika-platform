// Control's read of the installation's client logo from IAM (ADR-0066): bounded, so an IAM that never answers holds up
// no namespace mutation that reads it.

import { describe, expect, test } from 'bun:test'
import { iamBrandSource } from '../installation-brand'

describe("the installation's logo read from IAM", () => {
	test('answers the logo IAM keeps, with the provisioning key as the bearer', async () => {
		const seen: string[] = []
		const source = iamBrandSource({
			origin: 'https://iam.example.test/',
			provisioningKey: 'px_provisioning',
			fetch: async (input, init) => {
				seen.push(`${String(input)} ${new Headers(init?.headers).get('authorization')}`)
				return Response.json({ result: { brand: null } })
			},
		})
		expect(await source.read()).toBeNull()
		expect(seen).toEqual(['https://iam.example.test/admin/rpc Bearer px_provisioning'])
	})

	test('an IAM that takes the request and never answers fails the read once its time is up', async () => {
		const source = iamBrandSource({
			origin: 'https://iam.example.test',
			provisioningKey: 'px_provisioning',
			timeoutMs: 50,
			fetch: (_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
				}),
		})
		const started = performance.now()
		await expect(source.read()).rejects.toThrow()
		expect(performance.now() - started).toBeLessThan(2_000)
	})
})
