// The static reader accepts a public SPA as the runtime builds it, and refuses any other key beside `public`.

import { compileContract, defineContract } from '@fabrika/app/contract'
import { canonicalArtifactJson } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { ContractSourceError, readContract, readContractSource } from '../contract'

const source = (access: string): string =>
	`import { defineContract } from '@fabrika/app/contract'

export const contract = defineContract({
	app: 'intake',
	dimensions: { workspace: {} },
	actions: { 'intake.read': 'Read submissions' },
	roles: { reviewer: { grants: ['intake.read'], member: { scope: 'workspace', assignableBy: ['reviewer'] } } },
}, (c) => ({
	site: c.spa('/', { dir: 'dist/site', access: ${access} }),
	web: c.spa('/app', { dir: 'dist/app', access: { member: true } }),
}))
`

const evaluated = defineContract({
	app: 'intake',
	dimensions: { workspace: {} },
	actions: { 'intake.read': 'Read submissions' },
	roles: { reviewer: { grants: ['intake.read'], member: { scope: 'workspace', assignableBy: ['reviewer'] } } },
}, (c) => ({
	site: c.spa('/', { dir: 'dist/site', access: { public: true } }),
	web: c.spa('/app', { dir: 'dist/app', access: { member: true } }),
}))

function refusal(files: ReadonlyMap<string, string>): string[] {
	try {
		readContract(files)
	} catch (error) {
		if (error instanceof ContractSourceError) {
			return error.findings.map((finding) => `${finding.file}:${finding.line}:${finding.column} ${finding.rule} ${finding.message}`)
		}
		throw error
	}
	return []
}

describe('a public SPA in the static reader', () => {
	test('reads { public: true } into the same artifact and the same canonical bytes as the evaluated contract', () => {
		const read = readContractSource(new Map([['fabrika.contract.ts', source('{ public: true }')]]), {})
		expect(read).toEqual(compileContract(evaluated, {}))
		expect(canonicalArtifactJson(read)).toBe(canonicalArtifactJson(compileContract(evaluated, {})))
		expect(read.endpoints.find((row) => row.id === 'site')?.kind).toBe('public-spa')
	})

	test('refuses another key beside public, and a public that is not true', () => {
		expect(refusal(new Map([['fabrika.contract.ts', source('{ public: true, member: true }')]]))).toEqual([
			'fabrika.contract.ts:9:47 contract access is not an SPA access',
		])
		expect(refusal(new Map([['fabrika.contract.ts', source('{ public: false }')]]))).toEqual([
			'fabrika.contract.ts:9:47 contract access is not an SPA access',
		])
	})
})
