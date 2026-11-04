// `egress`: the HTTPS origins a site's code calls, exact or as a one-label pattern. The artifact records them per site,
// the build refuses them where no site calls out, and while a handler runs the guard on the global `fetch` refuses every
// other origin; the framework's own requests pass.

import { compileContract, defineApp, defineVocabulary } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { z } from 'zod/v4'
import { CapabilityRefusedError } from '../implement/capability'
import { installEgressGuard, platformCall, runAsSite } from '../implement/egress'

const vocabulary = defineVocabulary({
	app: 'outbound',
	dimensions: { project: {} },
	actions: { 'projects.read': 'Read projects' },
	roles: { reader: { grants: ['projects.read'] } },
})
const app = defineApp(vocabulary)
const Answer = z.strictObject({ status: z.int() })
const Target = z.strictObject({ url: z.string() })

const calls = app.group({ callers: ['human'] }, (r) => ({
	ping: r.query({
		input: Target,
		output: Answer,
		access: { action: 'projects.read', app: true },
		egress: ['https://api.example.com', 'https://hooks.example.com'],
	}).handle(async ({ input }) => ({ status: (await fetch(input.url)).status })),
	tenant: r.query({
		input: Target,
		output: Answer,
		access: { action: 'projects.read', app: true },
		egress: ['https://*.tenants.example.com'],
	}).handle(async ({ input }) => ({ status: (await fetch(input.url)).status })),
	quiet: r.query({ input: Target, output: Answer, access: { action: 'projects.read', app: true } })
		.handle(async ({ input }) => ({ status: (await fetch(input.url)).status })),
}))
const contract = app.contract((c) => ({ api: c.rpc('/api', { calls }), health: c.health('/healthz') }))

describe('the artifact and the build', () => {
	test('records each site that declares egress, its origins sorted, and nothing for one that declares none', () => {
		const artifact = compileContract(contract, {})
		expect(artifact.declared?.['api.calls.ping']?.egress).toEqual(['https://api.example.com', 'https://hooks.example.com'])
		expect(artifact.declared?.['api.calls.tenant']?.egress).toEqual(['https://*.tenants.example.com'])
		expect(artifact.declared?.['api.calls.quiet']).toBeUndefined()
	})

	const refused = (egress: readonly `https://${string}`[]): string => {
		const group = app.group({ callers: ['human'] }, (r) => ({
			call: r.query({ input: Target, output: Answer, access: { action: 'projects.read', app: true }, egress }).handle(() => ({ status: 200 })),
		}))
		return refusalOf(() => compileContract(app.contract((c) => ({ api: c.rpc('/api', { group }) })), {}))
	}

	test('refuses a path, an empty list and a duplicate', () => {
		expect(refused(['https://api.example.com/v1'])).toContain("egress 'https://api.example.com/v1' carries a path, query or credentials")
		expect(refused([])).toContain('egress is not a list of origins')
		expect(refused(['https://*.example.com', 'https://*.example.com'])).toContain('https://*.example.com')
	})

	test('refuses a pattern other than one leading label over a domain of its own, over https, written canonically', () => {
		expect(refused(['https://*.com'])).toContain("egress 'https://*.com' puts its wildcard on the public suffix 'com'")
		expect(refused(['https://*.co.uk'])).toContain("egress 'https://*.co.uk' puts its wildcard on the public suffix 'co.uk'")
		expect(refused(['https://*.*.example.com'])).toContain('has more than one wildcard label')
		expect(refused(['https://api.*.example.com'])).toContain('puts a wildcard elsewhere than one leading label')
		expect(refused(['https://*.Example.com'])).toContain("write it as 'https://*.example.com'")
		expect(refused(['https://*.example.com.'])).toContain("write it as 'https://*.example.com'")
		expect(refused(['https://*.example.com:443'])).toContain("write it as 'https://*.example.com'")
	})

	test('refuses egress on a public procedure, which reaches its actions only', () => {
		const open = app.group({}, (r) => ({
			call: r.query({ input: Target, output: Answer, access: { public: true }, actions: ['projects.read'], egress: ['https://api.example.com'] })
				.handle(() => ({ status: 200 })),
		}))
		expect(refusalOf(() => compileContract(app.contract((c) => ({ api: c.rpc('/api', { open }) })), {}))).toContain(
			'declares egress, which a public procedure never does',
		)
	})
})

function refusalOf(build: () => unknown): string {
	try {
		build()
	} catch (error) {
		return error instanceof Error ? error.message : String(error)
	}
	return ''
}

describe('the guard on fetch', () => {
	afterEach(() => {
		fetchStub?.mockRestore()
	})
	let fetchStub: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined

	test('a handler reaches its declared origins only, and a site that declares none reaches nothing', async () => {
		fetchStub = spyOn(globalThis, 'fetch').mockImplementation(
			Object.assign(async () => new Response('ok', { status: 202 }), { preconnect: fetch.preconnect }),
		)
		const kit = testKit(serve(contract, { database: null }))
		const call = kit.browser(kit.testCaller([{ action: 'projects.read' }]))
		const ask = async (procedure: string, url: string) =>
			call(`/api/calls.${procedure}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) })
		expect(await (await ask('ping', 'https://api.example.com/v1/items')).json()).toEqual({ result: { status: 202 } })
		expect((await ask('ping', 'https://evil.example.com/steal')).status).toBe(500)
		expect((await ask('ping', 'https://api.example.com.evil.net/')).status).toBe(500)
		expect((await ask('quiet', 'https://api.example.com/v1/items')).status).toBe(500)
		expect(fetchStub.mock.calls.map(([input]) => String(input))).toEqual(['https://api.example.com/v1/items'])
	})

	test('a pattern reaches one label under its domain, on its port, and nothing else', async () => {
		fetchStub = spyOn(globalThis, 'fetch').mockImplementation(
			Object.assign(async () => new Response('ok', { status: 202 }), { preconnect: fetch.preconnect }),
		)
		const kit = testKit(serve(contract, { database: null }))
		const call = kit.browser(kit.testCaller([{ action: 'projects.read' }]))
		const ask = async (url: string) =>
			(await call('/api/calls.tenant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) })).status
		expect(await ask('https://acme.tenants.example.com/v1')).toBe(200)
		expect(await ask('https://ACME.Tenants.Example.com./v1')).toBe(200)
		expect(await ask('https://a.b.tenants.example.com/')).toBe(500)
		expect(await ask('https://tenants.example.com/')).toBe(500)
		expect(await ask('https://evil-tenants.example.com/')).toBe(500)
		expect(await ask('https://acme.tenants.example.com.evil.net/')).toBe(500)
		expect(await ask('https://acme.tenants.example.com:8443/')).toBe(500)
		expect(await ask('http://acme.tenants.example.com/')).toBe(500)
		expect(fetchStub.mock.calls.map(([input]) => String(input))).toEqual([
			'https://acme.tenants.example.com/v1',
			'https://ACME.Tenants.Example.com./v1',
		])
	})

	test("a framework call inside a handler, and any call outside one, is the platform's and passes", async () => {
		fetchStub = spyOn(globalThis, 'fetch').mockImplementation(
			Object.assign(async () => new Response(null, { status: 204 }), { preconnect: fetch.preconnect }),
		)
		installEgressGuard()
		const refusal = await runAsSite("job 'mailing'", [], () => fetch('https://api.resend.com/emails')).catch((error: unknown) => error)
		expect(refusal).toBeInstanceOf(CapabilityRefusedError)
		expect(refusal).toMatchObject({
			message: "job 'mailing' calls https://api.resend.com, which it does not declare (egress: ['https://api.resend.com'])",
		})
		expect((await runAsSite("job 'mailing'", [], () => platformCall(() => fetch('https://api.resend.com/emails')))).status).toBe(204)
		expect((await fetch('https://api.resend.com/emails')).status).toBe(204)
	})
})
