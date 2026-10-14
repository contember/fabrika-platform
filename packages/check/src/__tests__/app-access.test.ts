// The app access form and the application table in the static reader: it reads `@fabrika/app`'s `app-wide-fixture/`
// into the same artifact as the evaluated contract, refuses the forms `buildArtifact` refuses, and the scaffold writes
// the generated cases of both.

import { compileContract, defineContract } from '@fabrika/app/contract'
import { canonicalArtifactJson } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { contract } from '../../../app/src/__tests__/app-wide-fixture/fabrika.contract'
import { tables } from '../../../app/src/__tests__/app-wide-fixture/src/db/tables'
import { ContractSourceError, readContractSource, readTablesSource } from '../contract'
import { ENDPOINT_ACCESS_TEST, generatedTests, policyTestPath, scaffoldInputs } from '../scaffold'
import { readTree } from './colocated-helpers'

const ROOT = join(import.meta.dir, '..', '..', '..', 'app', 'src', '__tests__', 'app-wide-fixture')
const ENDPOINTS = 'src/admin/endpoints.ts'

const withAccess = (from: string, to: string): Map<string, string> => {
	const files = readTree(ROOT)
	const source = files.get(ENDPOINTS) ?? ''
	expect(source).toContain(from)
	files.set(ENDPOINTS, source.replace(from, to))
	return files
}

const refusal = (files: ReadonlyMap<string, string>): string[] => {
	try {
		readContractSource(files)
	} catch (error) {
		if (error instanceof ContractSourceError) return error.findings.map((finding) => `${finding.rule} ${finding.message}`)
		throw error
	}
	return []
}

describe('application-wide data in the static reader', () => {
	test('reads the app form and the application tables into the same canonical artifact as the evaluated contract', () => {
		const files = readTree(ROOT)
		const read = readContractSource(files)
		expect(canonicalArtifactJson(read)).toBe(canonicalArtifactJson(compileContract(contract, tables)))
		expect(read.endpoints.find((row) => row.id === 'api.admin.export')?.requirement).toEqual({
			kind: 'action',
			action: 'candidates.read',
			access: { form: 'app' },
		})
		expect(readTablesSource(files)['exports']?.scope).toEqual({ mode: 'app', reason: 'the log of every export across all candidates', key: 'id' })
	})

	test('refuses an app form that is not the literal true, or that names a dimension too', () => {
		const access = "access: { action: 'positions.read', app: true }"
		expect(refusal(withAccess(access, "access: { action: 'positions.read', app: false }"))).toEqual(['contract access is not one access form'])
		expect(refusal(withAccess(access, "access: { action: 'positions.read', app: true, over: 'candidate' }"))).toEqual([
			'contract access is not one access form',
		])
	})
})

describe('an SPA of the app form', () => {
	const vocabulary = { app: 'registry', dimensions: { candidate: {} }, actions: { 'registry.admin': 'Administer the registry' }, roles: {} }
	const source = `import { defineContract } from '@fabrika/app/contract'

export const contract = defineContract(${JSON.stringify(vocabulary)}, (c) => ({
	admin: c.spa('/admin', { dir: 'dist/admin', access: { action: 'registry.admin', app: true } }),
}))
`

	test('reads into the same artifact as the evaluated contract: a row whose requirement needs the global grant', () => {
		const evaluated = defineContract(vocabulary, (c) => ({
			admin: c.spa('/admin', { dir: 'dist/admin', access: { action: 'registry.admin', app: true } }),
		}))
		const read = readContractSource(new Map([['fabrika.contract.ts', source]]), {})
		expect(canonicalArtifactJson(read)).toBe(canonicalArtifactJson(compileContract(evaluated, {})))
		expect(read.endpoints.find((row) => row.id === 'admin')?.requirement).toEqual({ kind: 'action', action: 'registry.admin', access: { form: 'app' } })
	})
})

describe('an export procedure of the app form', () => {
	test('is refused by the reader: a v1 export reads in one dimension', () => {
		const source = `import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'

export const contract = defineContract({ app: 'registry', dimensions: { candidate: {} }, actions: { 'candidates.read': 'Read' }, roles: {} }, (c) => ({
	exports: {
		candidates: c.export({
			version: 1,
			consumers: ['crm'],
			audience: 'candidates',
			procedures: { count: c.query({ output: z.strictObject({ n: z.int() }), access: { action: 'candidates.read', app: true } }) },
		}),
	},
}))
`
		expect(refusal(new Map([['fabrika.contract.ts', source]]))).toEqual(['contract an export procedure reads in one dimension'])
	})
})

describe('the generated cases of application-wide data', () => {
	test('an app endpoint gets a scoped refusal and a global reach; an application table gets the probe of its actions', async () => {
		const inputs = scaffoldInputs(readTree(ROOT))
		const tests = await generatedTests(inputs.policies, inputs.artifact, inputs.fixtures)
		const endpoints = tests.get(ENDPOINT_ACCESS_TEST)?.text ?? ''
		expect(endpoints).toContain("expect(await kit.scoped('api.admin.export', {})).toEqual({ status: 403 })")
		expect(endpoints).toContain("expect(await kit.global('api.admin.export', {})).toEqual({ answered: true })")
		const positions = tests.get(policyTestPath('positions'))
		expect(positions?.text).toContain("const kit = appPolicyIsolationKit(contract, tables, 'positions', postgres)")
		expect(positions?.cases).toEqual([
			'get by a global holder succeeds',
			'get by a holder in one scope only is 403',
			'a list by a global holder succeeds',
			'a list by a holder in one scope only is 403',
			'insert by a global holder succeeds',
			'insert by a holder in one scope only is 403',
			'update by a global holder succeeds',
			'update by a holder in one scope only is 403',
			'update refuses a capability of positions.read',
			'remove by a global holder succeeds',
			'remove by a holder in one scope only is 403',
			'remove refuses a capability of positions.read',
			'a scoped site of positions.read reads every row',
			'a scoped site of positions.manage reads no row',
		])
		expect(tests.get(policyTestPath('exports'))?.cases).toEqual([
			'get by a global holder succeeds',
			'get by a holder in one scope only is 403',
			'a list by a global holder succeeds',
			'a list by a holder in one scope only is 403',
			'insert by a global holder succeeds',
			'insert by a holder in one scope only is 403',
			'a scoped site of audit.read reads every row',
			'a scoped site of candidates.read reads no row',
		])
	})
})
