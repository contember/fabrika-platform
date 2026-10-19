// Public procedures in the static reader: a group without callers and its procedures read from source, and what the
// reader and `buildArtifact` refuse about them, each at the written line where the reader owns the refusal.

import { ContractError } from '@fabrika/app/contract'
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { ContractSourceError, readContractSource } from '../contract'
import { ENDPOINT_ACCESS_TEST, generatedTests, scaffoldInputs } from '../scaffold'
import { readTree } from './colocated-helpers'

const ROOT = join(import.meta.dir, '..', '..', '..', 'app', 'src', '__tests__', 'public-fixture')
const ENDPOINTS = 'src/intake/endpoints.ts'
const PRODUCTS = "products: r.query({ output: Products, access: { public: true }, actions: ['catalog.read'] })"

const withProducts = (declaration: string): Map<string, string> => {
	const files = readTree(ROOT)
	const source = files.get(ENDPOINTS) ?? ''
	expect(source).toContain(PRODUCTS)
	files.set(ENDPOINTS, source.replace(PRODUCTS, declaration))
	return files
}

const problemsOf = (files: Map<string, string>): string[] => {
	try {
		readContractSource(files)
	} catch (error) {
		if (error instanceof ContractSourceError) return error.findings.map((finding) => finding.message)
		if (error instanceof ContractError) return [...error.problems]
		throw error
	}
	throw new Error('the contract was read')
}

describe('public procedures in the static reader', () => {
	test('reads the public row, its workload actions and its admission', () => {
		const read = readContractSource(readTree(ROOT))
		expect(read.endpoints.find((row) => row.id === 'api.catalog.products')).toMatchObject({ kind: 'public', callers: [], requirement: null })
		expect(read.declared?.['api.catalog.products']?.actions).toEqual(['catalog.read'])
		expect(read.mounts['api']).toEqual({ kind: 'rpc', prefix: '/api', callers: ['human'] })
	})

	test('refuses a credentialed procedure in a group without callers, at its line', () => {
		expect(problemsOf(withProducts("products: r.query({ output: Products, access: { action: 'intake.read', app: true } })"))).toEqual([
			'a group without callers holds public procedures only',
		])
	})

	test('refuses a public procedure without actions, with reach off the road, or with a bucket of another kind', () => {
		expect(problemsOf(withProducts('products: r.query({ output: Products, access: { public: true } })')).join('\n')).toContain(
			"is public, so it declares what its handler holds: actions: ['<action>']",
		)
		expect(
			problemsOf(withProducts("products: r.query({ output: Products, access: { public: true }, actions: ['catalog.read'], sql: 'read' })")).join('\n'),
		).toContain('is public and declares sql')
		expect(
			problemsOf(
				withProducts(
					"products: r.query({ output: Products, access: { public: true }, actions: ['catalog.read'], admission: { rate: { perCaller: 5 } } })",
				),
			).join('\n'),
		).toContain('admission.rate.perCaller counts by the caller, and a public procedure has none')
	})

	test('refuses a limit past its ceiling', () => {
		expect(
			problemsOf(
				withProducts("products: r.query({ output: Products, access: { public: true }, actions: ['catalog.read'], limits: { timeoutMs: 120000 } })"),
			).join('\n'),
		).toContain('limits.timeoutMs 120000 is not a whole number of ms from 1 to 60000')
	})

	test('the scaffold writes a case per public procedure: anyone reaches it, or is refused without a solved challenge', async () => {
		const challenged = withProducts(
			"products: r.query({ input: z.strictObject({ challengeToken: z.string() }), output: Products, access: { public: true }, actions: ['catalog.read'], admission: { challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET' } } })",
		)
		const inputs = scaffoldInputs(challenged)
		const endpoints = (await generatedTests(inputs.policies, inputs.artifact, inputs.fixtures)).get(ENDPOINT_ACCESS_TEST)
		expect(endpoints?.cases).toContain('api.intake.register: anyone reaches it with no credential, running with intake.register')
		expect(endpoints?.cases).toContain('api.catalog.products: anyone without a solved challenge is 403')
		expect(endpoints?.text).toContain("await kit.anyone('api.intake.register', ")
	})
})
