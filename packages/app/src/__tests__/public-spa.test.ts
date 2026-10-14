// A public SPA (`c.spa(prefix, { dir, access: { public: true } })`): one anonymous `public-spa` row, served by the
// production proxy decision over the generated manifest and the real dispatcher, with no session and no token.

import { compileContract, ContractError, defineContract, parseContractArtifact } from '@fabrika/app/contract'
import { testKit } from '@fabrika/app/testing'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { implement } from '../implement/implement'

const Me = z.strictObject({ id: z.string() })

const vocabulary = {
	app: 'intake',
	dimensions: { workspace: {} },
	actions: { 'intake.read': 'Read submissions' },
	roles: { reviewer: { grants: ['intake.read'], member: { scope: 'workspace', assignableBy: ['reviewer'] } } },
} as const

const contract = defineContract(vocabulary, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, { me: c.query({ output: Me, access: { member: true } }) }),
	site: c.spa('/', { dir: 'dist/site', access: { public: true } }),
	web: c.spa('/app', { dir: 'dist/app', access: { member: true } }),
	health: c.health('/healthz'),
}))

const app = implement(contract, {
	database: null,
	deps: () => ({}),
	handlers: () => ({ api: { me: ({ ctx }) => ({ id: ctx.principal.id }) } }),
})

function problemsOf(compile: () => unknown): readonly string[] {
	try {
		compile()
	} catch (error) {
		if (error instanceof ContractError) {
			return error.problems
		}
		throw error
	}
	throw new Error('the contract compiled')
}

describe('the contract build', () => {
	test('a public SPA is one anonymous public-spa row: GET <prefix>/*, no callers, no requirement, no body', () => {
		const artifact = compileContract(contract, {})
		expect(artifact.endpoints.find((row) => row.id === 'site')).toEqual({
			id: 'site',
			source: { kind: 'mount', name: 'site' },
			kind: 'public-spa',
			method: 'GET',
			path: '/*',
			callers: [],
			requirement: null,
			admission: null,
			input: null,
			output: null,
		})
		expect(artifact.mounts['site']).toEqual({ kind: 'spa', prefix: '/', dir: 'dist/site' })
		expect(artifact.endpoints.find((row) => row.id === 'web')?.kind).toBe('spa')
	})

	test('{ public: true } takes no other key, and public is only true', () => {
		const mixed = defineContract(vocabulary, (c) => ({
			site: c.spa('/', { dir: 'dist/site', access: { public: true, member: true } }),
		}))
		expect(problemsOf(() => compileContract(mixed, {}))).toEqual([
			`mount 'site': access {"public":true,"member":true} is not an SPA access (allowed: { member: true }, { action, over }, { action, app: true } or { public: true })`,
		])
	})
})

describe('the artifact parser', () => {
	const artifact = compileContract(contract, {})
	const withSite = (fields: Record<string, unknown>): unknown => ({
		...artifact,
		endpoints: artifact.endpoints.map((row) => (row.id === 'site' ? { ...row, ...fields } : row)),
	})

	test('reads the public-spa row back unchanged', () => {
		expect(parseContractArtifact(JSON.parse(JSON.stringify(artifact)))).toEqual(artifact)
	})

	test.each<[string, Record<string, unknown>]>([
		['the method POST', { method: 'POST' }],
		['a body admission', { admission: { contentTypes: ['application/json'], maxBytes: 1024 } }],
		['an input schema', { input: { type: 'object', fields: {} } }],
		['an output schema', { output: { type: 'object', fields: {} } }],
		['a caller', { callers: ['human'] }],
	])('refuses a public-spa row with %s', (_name, fields) => {
		expect(() => parseContractArtifact(withSite(fields))).toThrow()
	})
})

describe('the production proxy and the dispatcher serve a public SPA anonymously', () => {
	test('an anonymous GET of the page and of an asset answers the files, with no session and no token upstream', async () => {
		const received: { readonly dir: string; readonly path: string; readonly token: string | null; readonly cookie: string | null }[] = []
		const kit = testKit(app, {
			assets: {
				serve: (mount, request) => {
					received.push({
						dir: mount.dir,
						path: new URL(request.url).pathname,
						token: request.headers.get('X-Fabrika-Token'),
						cookie: request.headers.get('Cookie'),
					})
					return Promise.resolve(new Response(`${mount.dir} ${new URL(request.url).pathname}`))
				},
			},
		})

		const page = await kit.fetch('/')
		expect(page.status).toBe(200)
		expect(await page.text()).toBe('dist/site /')
		expect(page.headers.get('Cache-Control')).toBe('no-store')
		expect(page.headers.get('Content-Security-Policy')).toContain("script-src 'self'")

		const asset = await kit.fetch('/assets/app.js')
		expect(asset.status).toBe(200)
		expect(await asset.text()).toBe('dist/site /assets/app.js')

		// A visitor who is also signed in: the proxy still mints nothing and forwards no session.
		const signedIn = await kit.browser(kit.testCaller([{ role: 'reviewer', scope: { type: 'workspace', value: 'w1' } }]))('/')
		expect(signedIn.status).toBe(200)

		expect(received).toEqual([
			{ dir: 'dist/site', path: '/', token: null, cookie: null },
			{ dir: 'dist/site', path: '/assets/app.js', token: null, cookie: null },
			{ dir: 'dist/site', path: '/', token: null, cookie: null },
		])
	})

	test('a POST to the page is refused by the proxy', async () => {
		const kit = testKit(app)
		const response = await kit.fetch('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
		expect(response.status).toBe(403)
	})

	test('the member SPA beside it still bounces to login, and every other call still needs a session', async () => {
		const kit = testKit(app)
		const member = await kit.fetch('/app/')
		expect(member.status).toBe(302)
		expect(member.headers.get('Location')).toStartWith('https://iam.test/auth/login?')

		const call = await kit.browser()('/api/me', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
		expect(call.status).toBe(401)
	})
})

describe("an SPA mount's bare prefix", () => {
	test('is a row of the mount under its own access, GET <prefix>, beside GET <prefix>/*; the root mount has none', () => {
		const artifact = compileContract(contract, {})
		const web = artifact.endpoints.find((row) => row.id === 'web')
		expect(web?.path).toBe('/app/*')
		expect(artifact.endpoints.find((row) => row.id === 'web.prefix')).toEqual(web === undefined ? undefined : { ...web, id: 'web.prefix', path: '/app' })
		expect(artifact.endpoints.filter((row) => row.source.kind === 'mount' && row.source.name === 'site').map((row) => row.path)).toEqual(['/*'])
		expect(parseContractArtifact(JSON.parse(JSON.stringify(artifact)))).toEqual(artifact)
	})

	test('redirects to <prefix>/ with its query, for a signed-in member; it never falls through to the root SPA', async () => {
		const kit = testKit(app, { assets: { serve: (mount) => Promise.resolve(new Response(mount.dir)) } })
		const member = kit.testCaller([{ role: 'reviewer', scope: { type: 'workspace', value: 'w1' } }])
		const bare = await kit.browser(member)('/app?tab=open')
		expect(bare.status).toBe(308)
		expect(bare.headers.get('Location')).toBe('/app/?tab=open')
		const anonymous = await kit.fetch('/app')
		expect(anonymous.status).toBe(302)
		expect(anonymous.headers.get('Location')).toStartWith('https://iam.test/auth/login?')
		expect(await (await kit.browser(member)('/app/')).text()).toBe('dist/app')
	})
})

