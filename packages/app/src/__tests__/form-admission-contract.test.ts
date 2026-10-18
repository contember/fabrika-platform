// What a form's admission and the script, frame, style and font origins compile to, and what `compileContract` refuses in them.

import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { compileContract, ContractError, defineContract } from '../contract'
import { applicationPolicy } from '../implement/headers'
import { contract as formFilesContract } from './fixtures/form-files/fabrika.contract'
import { tables as formFilesTables } from './fixtures/form-files/src/db/tables'
import { vocabulary as formFilesVocabulary } from './fixtures/form-files/src/vocabulary'
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

	test('a style origin and a font origin compile into the artifact and the policy, and are absent when undeclared', () => {
		const stylesheet = { origin: 'https://fonts.googleapis.com', purpose: 'the typeface stylesheet' }
		const fonts = { origin: 'https://fonts.gstatic.com', purpose: 'the typeface files' }
		const declared = defineContract(vocabulary, (c) => ({
			apply: c.form('/apply', { input: z.strictObject({ name: z.string(), email: z.email() }), appendTo: 'applications' }),
			contact: c.form('/contact', { input: z.strictObject({ email: z.email(), body: z.string() }), appendTo: 'messages' }),
			csp: { styleSrc: [stylesheet], fontSrc: [fonts] },
		}))
		const artifact = compileContract(declared, tables)
		expect(artifact.csp).toEqual({ connectSrc: [], imgSrc: [], frameAncestors: [], styleSrc: [stylesheet], fontSrc: [fonts] })
		const policy = applicationPolicy(artifact.csp, null).find(([name]) => name === 'Content-Security-Policy')?.[1]
		expect(policy).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;")
		expect(policy).toContain("font-src 'self' data: https://fonts.gstatic.com;")
		const plain = applicationPolicy({ connectSrc: [], imgSrc: [], frameAncestors: [] }, null).find(([name]) => name === 'Content-Security-Policy')?.[1]
		expect(plain).toContain("style-src 'self' 'unsafe-inline';")
		expect(plain).toContain("font-src 'self' data:;")
	})

	test('a style or font origin that is not https, or a wildcard', () => {
		const wrong = defineContract(vocabulary, (c) => ({
			apply: c.form('/apply', { input: z.strictObject({ name: z.string(), email: z.email() }), appendTo: 'applications' }),
			contact: c.form('/contact', { input: z.strictObject({ email: z.email(), body: z.string() }), appendTo: 'messages' }),
			csp: {
				styleSrc: [{ origin: 'http://fonts.example.com', purpose: 'A stylesheet' }],
				fontSrc: [{ origin: 'https://*.example.com', purpose: 'Any font' }],
			},
		}))
		expect(problemsOf(() => compileContract(wrong, tables))).toEqual([
			"csp styleSrc: 'http://fonts.example.com' is not an https origin (allowed: 'https://maps.example.com', no path or wildcard)",
			"csp fontSrc: 'https://*.example.com' is not an https origin (allowed: 'https://maps.example.com', no path or wildcard)",
		])
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

describe('a form that takes files', () => {
	const photos = (scan: boolean) =>
		({
			owner: 'candidates',
			read: 'candidates.read',
			write: 'candidates.attach',
			delete: 'candidates.review',
			maxBytes: 4096,
			types: ['image/jpeg'],
			...(scan ? { scan: true } : {}),
		}) as const
	const Register = z.strictObject({ email: z.email(), name: z.string(), website: z.optional(z.string()), challengeToken: z.string() })
	const challenge = { provider: 'turnstile', secret: 'TURNSTILE_SECRET' } as const

	test('is multipart in its row, bounded by maxBytes for its input, and names each file field in its mount', () => {
		const artifact = compileContract(formFilesContract, formFilesTables)
		expect(artifact.mounts['register']).toEqual({
			kind: 'form',
			path: '/register',
			appendTo: 'registrations',
			honeypot: 'website',
			challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET' },
			files: { photo: { collection: 'photos', required: false } },
		})
		expect(artifact.mounts['apply']).toMatchObject({ files: { portrait: { collection: 'photos', required: true } } })
		expect(artifact.endpoints.find((row) => row.id === 'register')?.admission).toEqual({ contentTypes: ['multipart/form-data'], maxBytes: 2048 })
	})

	test('needs a challenge, a declared collection that scans, and fields of their own that are inbox columns', () => {
		const wrong = defineContract(formFilesVocabulary, (c) => ({
			register: c.form('/register', {
				input: Register,
				appendTo: 'registrations',
				honeypot: 'website',
				files: { photo: { collection: 'portraits' }, website: { collection: 'photos' }, input: { collection: 'photos' } },
			}),
			apply: c.form('/apply', {
				input: z.strictObject({ email: z.email(), challengeToken: z.string() }),
				appendTo: 'applications',
				challenge,
				files: { portrait: { collection: 'unscanned' }, selfie: { collection: 'photos' } },
			}),
			files: { photos: c.files(photos(true)), unscanned: c.files(photos(false)) },
		}))
		expect(problemsOf(() => compileContract(wrong, formFilesTables))).toEqual([
			"mount 'register': takes files, so it declares a challenge: an anonymous upload needs a solved one (challenge: { provider: 'turnstile', … })",
			"mount 'register' file 'photo': collection \"portraits\" is not a file collection of the contract (collections: photos, unscanned)",
			"mount 'register' file 'website': is also the name of the input part, the challenge token, the honeypot or an input field; name the file its own field",
			"mount 'register' file 'input': is also the name of the input part, the challenge token, the honeypot or an input field; name the file its own field",
			"mount 'apply' file 'portrait': lands in files 'unscanned', which does not scan; an anonymous visitor's file waits for a clean verdict (scan: true)",
			"mount 'register': the input field 'challengeToken' is not a column of its inbox registrations (allowed: a field named like a column: id, email, name, photo, received_at)",
			"mount 'register': the file field 'input' is not a column of its inbox registrations (allowed: a field named like a column: id, email, name, photo, received_at)",
			"mount 'apply': the file field 'selfie' is not a column of its inbox applications (allowed: a field named like a column: id, email, portrait, received_at)",
		])
	})

	test('takes at most four file fields, each { collection, required? }', () => {
		const many = defineContract(formFilesVocabulary, (c) => ({
			apply: c.form('/apply', {
				input: z.strictObject({ email: z.email(), challengeToken: z.string() }),
				appendTo: 'applications',
				challenge,
				files: {
					a: { collection: 'photos' },
					b: { collection: 'photos' },
					c: { collection: 'photos' },
					d: { collection: 'photos' },
					e: { collection: 'photos' },
				},
			}),
			files: { photos: c.files(photos(true)) },
		}))
		expect(problemsOf(() => compileContract(many, formFilesTables))[0]).toBe(
			"mount 'apply': files declares 5 file fields (allowed: 1 to 4, one file each)",
		)
	})
})
