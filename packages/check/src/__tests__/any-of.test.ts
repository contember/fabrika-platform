// The anyOf access form in the static reader: it reads `@fabrika/app`'s `any-of-fixture/` into the same artifact as the
// evaluated contract, its list sorted, and refuses what `buildArtifact` refuses.

import { compileContract, ContractError } from '@fabrika/app/contract'
import { canonicalArtifactJson } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { contract } from '../../../app/src/__tests__/any-of-fixture/fabrika.contract'
import { tables } from '../../../app/src/__tests__/any-of-fixture/src/db/tables'
import { ContractSourceError, readContractSource } from '../contract'
import { readTree } from './colocated-helpers'

const ROOT = join(import.meta.dir, '..', '..', '..', 'app', 'src', '__tests__', 'any-of-fixture')
const ENDPOINTS = 'src/cash/endpoints.ts'
const ACCESS = "access: { anyOf: ['cash.read', 'cash.audit'], app: true }"

const withAccess = (to: string): Map<string, string> => {
	const files = readTree(ROOT)
	const source = files.get(ENDPOINTS) ?? ''
	expect(source).toContain(ACCESS)
	files.set(ENDPOINTS, source.replace(ACCESS, to))
	return files
}

const refusal = (files: ReadonlyMap<string, string>): string[] => {
	try {
		readContractSource(files)
	} catch (error) {
		if (error instanceof ContractSourceError) return error.findings.map((finding) => finding.message)
		// What the reader reads, `buildArtifact` judges: it refuses the list as it refuses an evaluated one.
		if (error instanceof ContractError) return [...error.problems]
		throw error
	}
	return []
}

describe('the anyOf access form in the static reader', () => {
	test('reads into the same canonical artifact as the evaluated contract, the list sorted', () => {
		const read = readContractSource(readTree(ROOT))
		expect(canonicalArtifactJson(read)).toBe(canonicalArtifactJson(compileContract(contract, tables)))
		expect(read.endpoints.find((row) => row.id === 'api.cash.detail')?.requirement).toEqual({
			kind: 'anyOf',
			actions: ['cash.audit', 'cash.read'],
			access: { form: 'app' },
		})
	})

	test('refuses an anyOf that is not the app form or takes another key, lists one or seventeen, repeats one, or names one outside the vocabulary', () => {
		expect(refusal(withAccess("access: { anyOf: ['cash.read', 'cash.audit'], app: false }"))).toEqual(['access is not one access form'])
		expect(refusal(withAccess("access: { anyOf: ['cash.read', 'cash.audit'], over: 'branch' }"))).toEqual(['access is not one access form'])
		expect(refusal(withAccess("access: { anyOf: ['cash.read', 'cash.audit'], app: true, creates: 'branch' }"))).toEqual([
			'access is not one access form',
		])
		expect(refusal(withAccess("access: { anyOf: ['cash.read'], app: true }"))).toEqual([
			"procedure 'api.cash.detail': access.anyOf lists one action (allowed: { anyOf: ['<action>', …], app: true }, two to 16 distinct actions)",
		])
		const seventeen = Array.from({ length: 17 }, (_, index) => `'cash.a${index}'`).join(', ')
		expect(refusal(withAccess(`access: { anyOf: [${seventeen}], app: true }`))).toEqual([
			"procedure 'api.cash.detail': access.anyOf lists 17 actions (allowed: { anyOf: ['<action>', …], app: true }, two to 16 distinct actions)",
		])
		expect(refusal(withAccess("access: { anyOf: ['cash.read', 'cash.read'], app: true }"))).toEqual([
			"procedure 'api.cash.detail': access.anyOf lists 'cash.read' twice",
		])
		expect(refusal(withAccess("access: { anyOf: ['cash.read', 'cash.close'], app: true }"))).toEqual([
			"procedure 'api.cash.detail': 'cash.close' is not an action of the contract",
		])
	})
})
