// What a public procedure's admission and the script, frame, style and font origins compile to, and what
// `compileContract` refuses in them.

import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { type AnyContract, compileContract, ContractError, file } from '../contract'
import { applicationPolicy } from '../implement/headers'
import { app } from './public-fixture/src/app-kit'
import { tables } from './public-fixture/src/db/tables'

const Apply = z.strictObject({ name: z.string(), challengeToken: z.string() })
const Empty = z.strictObject({})
const challenge = { provider: 'turnstile', secret: 'TURNSTILE_SECRET' } as const
const PUBLIC = { public: true } as const

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

const compiled = (contract: AnyContract) => compileContract(contract, tables)

/** `options` with `key` set, as a cast or a hand-written declaration would set what the kit's types refuse. */
const withField = <const T extends object>(options: T, key: string, value: unknown): T => {
	Object.defineProperty(options, key, { value, enumerable: true })
	return options
}

describe("a public procedure's admission in the artifact", () => {
	test('carries the declared rate and challenge, and the provider origins join script-src and frame-src', () => {
		const join = app.group({}, (r) => ({
			apply: r.mutation({
				input: Apply,
				output: Empty,
				access: PUBLIC,
				actions: ['intake.register'],
				admission: { rate: { perClient: 3, perEndpoint: 5 }, challenge },
			}).handle(() => ({})),
		}))
		const artifact = compiled(app.contract((c) => ({ api: c.rpc('/api', { join }) })))
		expect(artifact.procedures?.['api.join.apply']).toMatchObject({
			rate: { perClient: 3, perCaller: null, perEndpoint: 5, bytesPerHour: null },
			challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET' },
		})
		const widget = { origin: 'https://challenges.cloudflare.com', purpose: "the turnstile challenge of 'api.join.apply'" }
		expect(artifact.csp.scriptSrc).toEqual([widget])
		expect(artifact.csp.frameSrc).toEqual([widget])
	})

	test('a procedure that declares no challenge carries none, and the policy names no provider', () => {
		const join = app.group({}, (r) => ({
			apply: r.mutation({ input: Apply, output: Empty, access: PUBLIC, actions: ['intake.register'] }).handle(() => ({})),
		}))
		const artifact = compiled(app.contract((c) => ({ api: c.rpc('/api', { join }) })))
		expect(artifact.procedures?.['api.join.apply']?.challenge).toBeNull()
		expect(artifact.csp).toEqual({ connectSrc: [], imgSrc: [], frameAncestors: [] })
	})

	test('a script or frame origin the contract names itself is kept once, with its own purpose', () => {
		const own = { origin: 'https://challenges.cloudflare.com', purpose: 'the registration widget' }
		const join = app.group({}, (r) => ({
			apply: r.mutation({ input: Apply, output: Empty, access: PUBLIC, actions: ['intake.register'], admission: { challenge } }).handle(() => ({})),
		}))
		const artifact = compiled(app.contract((c) => ({
			api: c.rpc('/api', { join }),
			csp: { scriptSrc: [own, { origin: 'https://maps.example.com', purpose: 'the office map' }], frameSrc: [own] },
		})))
		expect(artifact.csp.scriptSrc).toEqual([own, { origin: 'https://maps.example.com', purpose: 'the office map' }])
		expect(artifact.csp.frameSrc).toEqual([own])
	})
})

describe('compileContract refuses', () => {
	test('a rate out of bounds, a bucket the procedure does not count by, and a challenge without its token field', () => {
		const join = app.group({}, (r) => ({
			apply: r.mutation({
				input: z.strictObject({ name: z.string() }),
				output: Empty,
				access: PUBLIC,
				actions: ['intake.register'],
				admission: { rate: withField({ perClient: 0, perEndpoint: 20_000 }, 'perCaller', 5), challenge },
			}).handle(() => ({})),
		}))
		const staff = app.group({ callers: ['human'] }, (r) => ({
			add: r.mutation({
				input: Apply,
				output: Empty,
				access: { action: 'catalog.write', app: true },
				admission: withField({ rate: withField({}, 'perClient', 5) }, 'challenge', challenge),
			}).handle(() => ({})),
		}))
		expect(problemsOf(() => compiled(app.contract((c) => ({ api: c.rpc('/api', { join, staff }) }))))).toEqual([
			"procedure 'api.join.apply': admission.rate.perClient 0 is not a whole number of calls per minute from 1 to 10000",
			"procedure 'api.join.apply': admission.rate.perEndpoint 20000 is not a whole number of calls per minute from 1 to 10000",
			"procedure 'api.join.apply': admission.rate.perCaller counts by the caller, and a public procedure has none (allowed: perClient)",
			"procedure 'api.join.apply': declares a challenge, so its input needs the required field challengeToken: z.string(), the widget's token",
			"procedure 'api.staff.add': admission.rate.perClient counts by the client address, which only a public procedure does (allowed: perCaller)",
			"procedure 'api.staff.add': admission.challenge belongs to a public procedure only",
		])
	})

	test('a challenge whose secret is a value or a framework variable', () => {
		for (const secret of ['0x4AAAAAAA-a-secret-value', 'FABRIKA_PROXY_SECRET']) {
			const join = app.group({}, (r) => ({
				apply: r.mutation({
					input: Apply,
					output: Empty,
					access: PUBLIC,
					actions: ['intake.register'],
					admission: { challenge: { provider: 'turnstile', secret } },
				}).handle(() => ({})),
			}))
			expect(problemsOf(() => compiled(app.contract((c) => ({ api: c.rpc('/api', { join }) }))))).toEqual([
				`procedure 'api.join.apply': challenge secret "${secret}" is not the name of an application variable (allowed: 'TURNSTILE_SECRET'; never the secret itself, never FABRIKA_*)`,
			])
		}
	})

	test('a style or font origin that is not https, or a wildcard', () => {
		const contract = app.contract(() => ({
			csp: {
				styleSrc: [{ origin: 'http://fonts.example.com', purpose: 'A stylesheet' }],
				fontSrc: [{ origin: 'https://*.example.com', purpose: 'Any font' }],
			},
		}))
		expect(problemsOf(() => compiled(contract))).toEqual([
			"csp styleSrc: 'http://fonts.example.com' is not an https origin (allowed: 'https://maps.example.com', no path or wildcard)",
			"csp fontSrc: 'https://*.example.com' is not an https origin (allowed: 'https://maps.example.com', no path or wildcard)",
		])
	})

	test('a script or frame origin that is not https, or a wildcard', () => {
		const contract = app.contract(() => ({
			csp: {
				scriptSrc: [{ origin: 'http://widgets.example.com', purpose: 'A widget' }],
				frameSrc: [{ origin: 'https://*.example.com', purpose: 'Any frame' }],
			},
		}))
		expect(problemsOf(() => compiled(contract))).toEqual([
			"csp scriptSrc: 'http://widgets.example.com' is not an https origin (allowed: 'https://maps.example.com', no path or wildcard)",
			"csp frameSrc: 'https://*.example.com' is not an https origin (allowed: 'https://maps.example.com', no path or wildcard)",
		])
	})
})

describe('a style and a font origin', () => {
	test('compile into the artifact and the policy, and are absent when undeclared', () => {
		const stylesheet = { origin: 'https://fonts.googleapis.com', purpose: 'the typeface stylesheet' }
		const fonts = { origin: 'https://fonts.gstatic.com', purpose: 'the typeface files' }
		const artifact = compiled(app.contract(() => ({ csp: { styleSrc: [stylesheet], fontSrc: [fonts] } })))
		expect(artifact.csp).toEqual({ connectSrc: [], imgSrc: [], frameAncestors: [], styleSrc: [stylesheet], fontSrc: [fonts] })
		const policy = applicationPolicy(artifact.csp, null).find(([name]) => name === 'Content-Security-Policy')?.[1]
		expect(policy).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;")
		expect(policy).toContain("font-src 'self' data: https://fonts.gstatic.com;")
		const plain = applicationPolicy({ connectSrc: [], imgSrc: [], frameAncestors: [] }, null).find(([name]) => name === 'Content-Security-Policy')?.[1]
		expect(plain).toContain("style-src 'self' 'unsafe-inline';")
		expect(plain).toContain("font-src 'self' data:;")
	})
})

describe('a public procedure that takes files', () => {
	const Register = z.strictObject({ name: z.string(), challengeToken: z.string(), photo: file('photos') })
	const kinds = (scan: boolean) => ({ photos: { types: ['image/png'], maxBytes: 4096, ...(scan ? { scan: true } : {}) } }) as const

	test('is budgeted in bytes and challenged, each of its kinds scans, and the budget fits its largest file', () => {
		const join = app.group({}, (r) => ({
			bare: r.mutation({ input: Register, output: Empty, access: PUBLIC, actions: ['intake.register'] }).handle(() => ({})),
			small: r.mutation({
				input: Register,
				output: Empty,
				access: PUBLIC,
				actions: ['intake.register'],
				admission: { rate: { bytesPerHour: 100 }, challenge },
			}).handle(() => ({})),
			fileless: r.mutation({
				input: Apply,
				output: Empty,
				access: PUBLIC,
				actions: ['intake.register'],
				admission: { rate: { bytesPerHour: 1_000_000 }, challenge },
			}).handle(() => ({})),
		}))
		const unscanned = app.contract((c) => ({ api: c.rpc('/api', { join }), files: { photos: c.files(kinds(false).photos) } }))
		expect(problemsOf(() => compiled(unscanned))).toEqual([
			"procedure 'api.join.bare': is public and takes files, so it declares admission.rate.bytesPerHour and admission.challenge: an anonymous upload is budgeted and challenged",
			"procedure 'api.join.bare': is public and takes files, so each of its file kinds scans (scan: true): an anonymous visitor's file waits for a clean verdict",
			"procedure 'api.join.small': admission.rate.bytesPerHour 100 is less than the 4096 bytes one of its files may hold",
			"procedure 'api.join.small': is public and takes files, so each of its file kinds scans (scan: true): an anonymous visitor's file waits for a clean verdict",
			"procedure 'api.join.fileless': admission.rate.bytesPerHour bounds the bytes of file fields, and the input declares none",
		])
	})

	test('declared with a budget, a challenge and a scanning kind, it compiles with its budget', () => {
		const join = app.group({}, (r) => ({
			register: r.mutation({
				input: Register,
				output: Empty,
				access: PUBLIC,
				actions: ['intake.register'],
				admission: { rate: { bytesPerHour: 1_000_000 }, challenge },
			}).handle(() => ({})),
		}))
		const artifact = compiled(app.contract((c) => ({ api: c.rpc('/api', { join }), files: { photos: c.files(kinds(true).photos) } })))
		expect(artifact.procedures?.['api.join.register']?.rate.bytesPerHour).toBe(1_000_000)
	})
})
