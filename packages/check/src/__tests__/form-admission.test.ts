// A form's rate, honeypot and challenge, and the script and frame origins, in the static reader: it reads them into
// the artifact the runtime compiles, and refuses a form it does not know.

import { compileContract, defineContract } from '@fabrika/app/contract'
import { canonicalArtifactJson, type TablePolicyArtifact } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { ContractSourceError, readContractSource } from '../contract'

const INBOX: TablePolicyArtifact = {
	scope: { mode: 'inbox', form: 'apply' },
	actions: { read: 'intake.read', insert: null, update: null, delete: null },
	insert: [],
	update: [],
	version: null,
	createdBy: null,
	columns: {},
}
const TABLES = { applications: INBOX }

const VOCABULARY = {
	app: 'intake',
	dimensions: {},
	actions: { 'intake.read': 'Read registrations' },
	roles: { hr: { grants: ['intake.read'] } },
} as const

const source = (options: string, csp = ''): string =>
	`import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'

export const contract = defineContract({
	app: 'intake',
	dimensions: {},
	actions: { 'intake.read': 'Read registrations' },
	roles: { hr: { grants: ['intake.read'] } },
}, (c) => ({
	apply: c.form('/apply', {
		input: z.strictObject({ name: z.string(), website: z.optional(z.string()), challengeToken: z.string() }),
		appendTo: 'applications',
		${options}
	}),${csp}
}))
`

const files = (options: string, csp?: string) => new Map([['fabrika.contract.ts', source(options, csp)]])

const evaluated = defineContract(VOCABULARY, (c) => ({
	apply: c.form('/apply', {
		input: z.strictObject({ name: z.string(), website: z.optional(z.string()), challengeToken: z.string() }),
		appendTo: 'applications',
		honeypot: 'website',
		challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET' },
		rate: { perClient: 30 },
	}),
	csp: { scriptSrc: [{ origin: 'https://maps.example.com', purpose: 'the office map' }] },
}))

function refusal(read: () => unknown): string[] {
	try {
		read()
	} catch (error) {
		if (error instanceof ContractSourceError) {
			return error.findings.map((finding) => `${finding.file}:${finding.line}:${finding.column} ${finding.message}`)
		}
		throw error
	}
	return []
}

describe('a form admission in the static reader', () => {
	test('reads the rate, the honeypot, the challenge and a script origin into the artifact the runtime compiles', () => {
		const read = readContractSource(
			files(
				"honeypot: 'website', challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET' }, rate: { perClient: 30 },",
				"\n\tcsp: { scriptSrc: [{ origin: 'https://maps.example.com', purpose: 'the office map' }] },",
			),
			TABLES,
		)
		expect(read).toEqual(compileContract(evaluated, TABLES))
		expect(canonicalArtifactJson(read)).toBe(canonicalArtifactJson(compileContract(evaluated, TABLES)))
		expect(read.csp.scriptSrc?.map((source) => source.origin)).toEqual(['https://challenges.cloudflare.com', 'https://maps.example.com'])
		expect(read.csp.frameSrc?.map((source) => source.origin)).toEqual(['https://challenges.cloudflare.com'])
	})

	test('refuses an unknown provider, a field the rate does not have, and a secret that is not text', () => {
		expect(refusal(() => readContractSource(files("challenge: { provider: 'recaptcha', secret: 'RECAPTCHA_SECRET' },"), TABLES))).toEqual([
			'fabrika.contract.ts:13:26 challenge needs a known provider',
		])
		expect(refusal(() => readContractSource(files('rate: { perMinute: 5 },'), TABLES))).toEqual([
			"fabrika.contract.ts:13:22 'perMinute' is not a field of rate",
		])
		expect(refusal(() => readContractSource(files("challenge: { provider: 'turnstile', secret: 42 },"), TABLES))).toEqual([
			'fabrika.contract.ts:13:47 secret is a number',
		])
	})

	test('refuses a script or frame origin that is not https, or a wildcard, as the runtime build does', () => {
		const csp =
			"\n\tcsp: { scriptSrc: [{ origin: 'http://widgets.example', purpose: 'A widget' }], frameSrc: [{ origin: 'https://*.example.com', purpose: 'Any' }] },"
		expect(() => readContractSource(files('', csp), TABLES)).toThrow("csp scriptSrc: 'http://widgets.example' is not an https origin")
		expect(() => readContractSource(files('', csp), TABLES)).toThrow("csp frameSrc: 'https://*.example.com' is not an https origin")
	})
})
