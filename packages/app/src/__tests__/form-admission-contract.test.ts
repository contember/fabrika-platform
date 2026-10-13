// What a form's admission and the script and frame origins compile to, and what `compileContract` refuses in them.

import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { compileContract, ContractError, defineContract } from '../contract'
import { contract } from './fixtures/intake/fabrika.contract'
import { tables } from './fixtures/intake/src/db/tables'
import { vocabulary } from './fixtures/intake/src/vocabulary'

const Contact = z.strictObject({ email: z.email(), body: z.string().min(1), website: z.optional(z.string()) })
const Application = z.strictObject({ name: z.string(), email: z.email(), challengeToken: z.string() })

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

describe('a form admission in the artifact', () => {
	test('carries the declared rate, honeypot and challenge, and the provider origins join script-src and frame-src', () => {
		const artifact = compileContract(contract, tables)
		expect(artifact.mounts['apply']).toEqual({
			kind: 'form',
			path: '/apply',
			appendTo: 'applications',
			rate: { perClient: 3, perForm: 5 },
			honeypot: 'website',
			challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET' },
		})
		const widget = { origin: 'https://challenges.cloudflare.com', purpose: "the turnstile challenge of 'apply'" }
		expect(artifact.csp.scriptSrc).toEqual([widget])
		expect(artifact.csp.frameSrc).toEqual([widget])
	})

	test('a form that declares none of them carries none, so its artifact and digest stay what they were', () => {
		const plain = defineContract(vocabulary, (c) => ({
			contact: c.form('/contact', { input: z.strictObject({ email: z.email(), body: z.string().min(1) }), appendTo: 'messages' }),
			apply: c.form('/apply', { input: z.strictObject({ name: z.string(), email: z.email() }), appendTo: 'applications' }),
		}))
		const artifact = compileContract(plain, tables)
		expect(artifact.mounts['contact']).toEqual({ kind: 'form', path: '/contact', appendTo: 'messages' })
		expect(artifact.csp).toEqual({ connectSrc: [], imgSrc: [], frameAncestors: [] })
	})

	test('a script or frame origin the contract names itself is kept once, with its own purpose', () => {
		const own = { origin: 'https://challenges.cloudflare.com', purpose: 'the registration widget' }
		const declared = defineContract(vocabulary, (c) => ({
			apply: c.form('/apply', {
				input: Application,
				appendTo: 'applications',
				challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET' },
			}),
			contact: c.form('/contact', { input: z.strictObject({ email: z.email(), body: z.string() }), appendTo: 'messages' }),
			csp: { scriptSrc: [own, { origin: 'https://maps.example.com', purpose: 'the office map' }], frameSrc: [own] },
		}))
		const artifact = compileContract(declared, tables)
		expect(artifact.csp.scriptSrc).toEqual([{ origin: 'https://challenges.cloudflare.com', purpose: 'the registration widget' }, {
			origin: 'https://maps.example.com',
			purpose: 'the office map',
		}])
		expect(artifact.csp.frameSrc).toEqual([own])
	})
})

describe('compileContract refuses', () => {
	test('a honeypot that is no string field of the input, a rate out of bounds and a challenge without its token field', () => {
		const wrong = defineContract(vocabulary, (c) => ({
			contact: c.form('/contact', { input: Contact, appendTo: 'messages', honeypot: 'email2', rate: { perClient: 0, perForm: 20_000 } }),
			apply: c.form('/apply', {
				input: z.strictObject({ name: z.string(), email: z.email(), age: z.optional(z.int()) }),
				appendTo: 'applications',
				honeypot: 'age',
				challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET' },
			}),
		}))
		expect(problemsOf(() => compileContract(wrong, tables))).toEqual([
			"mount 'contact' rate: perClient 0 is not a whole number of submissions per minute from 1 to 10000",
			"mount 'contact' rate: perForm 20000 is not a whole number of submissions per minute from 1 to 10000",
			"mount 'contact': honeypot 'email2' is not a field of its input (allowed: a z.string() field the form's page hides)",
			"mount 'apply': honeypot 'age' is not a string field (allowed: z.string() or z.optional(z.string()))",
			"mount 'apply': declares a challenge, so its input needs the required field challengeToken: z.string(), the widget's token",
			// Its honeypot names no field, so the page's hidden field is an input field like any other.
			"mount 'contact': the input field 'website' is not a column of its inbox messages (allowed: a field named like a column: email, body)",
		])
	})

	test('a challenge whose secret is a value or a framework variable', () => {
		const secrets = ['0x4AAAAAAA-a-secret-value', 'FABRIKA_PROXY_SECRET']
		for (const secret of secrets) {
			const wrong = defineContract(vocabulary, (c) => ({
				apply: c.form('/apply', { input: Application, appendTo: 'applications', challenge: { provider: 'turnstile', secret } }),
				contact: c.form('/contact', { input: z.strictObject({ email: z.email(), body: z.string() }), appendTo: 'messages' }),
			}))
			expect(problemsOf(() => compileContract(wrong, tables))).toEqual([
				`mount 'apply': challenge secret "${secret}" is not the name of an application variable (allowed: 'TURNSTILE_SECRET'; never the secret itself, never FABRIKA_*)`,
			])
		}
	})

	test('a script or frame origin that is not https, or a wildcard', () => {
		const wrong = defineContract(vocabulary, (c) => ({
			apply: c.form('/apply', { input: z.strictObject({ name: z.string(), email: z.email() }), appendTo: 'applications' }),
			contact: c.form('/contact', { input: z.strictObject({ email: z.email(), body: z.string() }), appendTo: 'messages' }),
			csp: {
				scriptSrc: [{ origin: 'http://widgets.example.com', purpose: 'A widget' }],
				frameSrc: [{ origin: 'https://*.example.com', purpose: 'Any frame' }],
			},
		}))
		expect(problemsOf(() => compileContract(wrong, tables))).toEqual([
			"csp scriptSrc: 'http://widgets.example.com' is not an https origin (allowed: 'https://maps.example.com', no path or wildcard)",
			"csp frameSrc: 'https://*.example.com' is not an https origin (allowed: 'https://maps.example.com', no path or wildcard)",
		])
	})
})
