// A Zerops namespace pinned to an older proxy source runs that release's strict manifest parser. A deploy is refused
// only for a row or a CSP no proxy of the window reads (`entriesNeedingCurrentProxy`), judged by those releases' own
// parsers: every row form and CSP directive no proxy of the window knows is refused, and every entry a 0.4, 0.5, 0.6 or
// 0.7 application compiles to deploys.

import { type BodyAdmission, type ContractArtifact, contractDigest, type EndpointRow } from '@fabrika/auth-core'
import type { ProviderApprovedAccess } from '@fabrika/provider-contract'
import { entriesNeedingCurrentProxy, type OlderProxyReaders } from '@fabrika/provider-zerops'
import { proxyEndpointRowSchema as proxyEndpointRowSchema05 } from '@fabrika/proxy-core-0.5/manifest'
import { contractProxyTable, type ProxyEndpointRow, proxyEndpointRowSchema } from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { contract as intakeContract } from '../../../app/src/__tests__/fixtures/intake/fabrika.contract'
import { tables as intakeTables } from '../../../app/src/__tests__/fixtures/intake/src/db/tables'
import { compileContract } from '../../../app/src/contract/compile'
import { schemaFromContract } from '../../../app/src/contract/platform'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { readAccessSnapshot } from '../approval/read'
import { approvedAccess } from '../approval/snapshot'
import { OLDER_PROXY_READERS } from '../zerops/older-proxies'
import { memoryCommits } from './helpers/commits'

const access = (endpoints: readonly EndpointRow[]): ProviderApprovedAccess => {
	const contract: ContractArtifact = { ...notesArtifact, endpoints: [...notesArtifact.endpoints, ...endpoints] }
	return { contract, contractDigest: contractDigest(contract), schema: schemaFromContract(contract), checker: '0.7.0' }
}

const mount: EndpointRow['source'] = { kind: 'mount', name: 'api' }
const empty: EndpointRow['input'] = { type: 'object', fields: {} }
const json: BodyAdmission = { contentTypes: ['application/json'], maxBytes: 1024 }

/** The proxies of the window older than 0.7: 0.4.8, 0.5.5 and 0.6.0, which know none of the rows 0.7 added. */
const [proxy04, ...after04] = OLDER_PROXY_READERS
const BEFORE_07: OlderProxyReaders = [proxy04, ...after04.slice(0, 2)]

describe('the rows 0.7 added, for a namespace proxy pinned to an older source', () => {
	test.each<[string, EndpointRow]>([
		['a public procedure', {
			id: 'api.stats.cta',
			source: mount,
			kind: 'public',
			method: 'POST',
			path: '/api/stats.cta',
			callers: [],
			requirement: null,
			admission: json,
			input: empty,
			output: empty,
		}],
		['a public GET query that caches its answer', {
			id: 'api.catalog.products',
			source: mount,
			kind: 'public',
			method: 'GET',
			path: '/api/catalog.products',
			callers: [],
			requirement: null,
			admission: null,
			input: empty,
			output: empty,
			cache: { maxAgeSeconds: 60 },
		}],
		['a procedure that answers a stored file', {
			id: 'api.reports.file',
			source: mount,
			kind: 'query',
			method: 'GET',
			path: '/api/reports.file',
			callers: ['human'],
			requirement: { kind: 'member' },
			admission: null,
			input: empty,
			output: { type: 'file', kind: 'report' },
			response: 'file',
		}],
		['an endpoint of several capabilities', {
			id: 'api.notes.move',
			source: mount,
			kind: 'mutation',
			method: 'POST',
			path: '/api/notes.move',
			callers: ['human'],
			admission: json,
			input: empty,
			output: empty,
			requirement: {
				kind: 'capabilities',
				capabilities: {
					from: { action: 'notes.write', access: { form: 'on', dimension: 'note', from: 'id' } },
					to: { action: 'notes.write', access: { form: 'in', dimension: 'workspace', from: 'workspaceId' } },
				},
			},
		}],
		['a webhook that forwards its own Authorization to a basic or bearer verifier', {
			id: 'billing',
			source: { kind: 'mount', name: 'billing' },
			kind: 'webhook',
			method: 'POST',
			path: '/hooks/billing/:bindingId',
			callers: [],
			requirement: null,
			admission: json,
			input: empty,
			output: null,
			authorization: 'forward',
		}],
	])('deploys %s, which a proxy at 0.7 parses, and refuses it below 0.7', (_name, row) => {
		expect(entriesNeedingCurrentProxy(access([row]), OLDER_PROXY_READERS)).toEqual([])
		expect(entriesNeedingCurrentProxy(access([row]), BEFORE_07)).toEqual([row.id])
	})

	test('deploys a GET mutation, whose row an older proxy parses and applies as this one does', () => {
		const row: EndpointRow = {
			id: 'api.mail.click',
			source: mount,
			kind: 'mutation',
			method: 'GET',
			path: '/api/mail.click',
			callers: ['human'],
			requirement: { kind: 'member' },
			admission: null,
			input: empty,
			output: empty,
		}
		expect(entriesNeedingCurrentProxy(access([row]), OLDER_PROXY_READERS)).toEqual([])
	})

	test('deploys an application of this release that uses none of them', () => {
		expect(entriesNeedingCurrentProxy(access([]), OLDER_PROXY_READERS)).toEqual([])
	})
})

describe("an entry's CSP, for a namespace proxy pinned to an older source", () => {
	test("refuses worker-src blob:, which no older proxy's CSP parser knows, and deploys every directive they do", () => {
		const workers = { origin: 'blob:', purpose: 'the workers of the altcha challenge' }
		const withWorkers = (base: ProviderApprovedAccess): ProviderApprovedAccess => {
			const contract: ContractArtifact = { ...base.contract, csp: { ...base.contract.csp, workerSrc: [workers] } }
			return { ...base, contract, contractDigest: contractDigest(contract) }
		}
		expect(entriesNeedingCurrentProxy(withWorkers(access([])), OLDER_PROXY_READERS)).toEqual(['csp'])
		const fonts = { origin: 'https://fonts.gstatic.com', purpose: 'the typeface files' }
		const typeface: ContractArtifact = { ...notesArtifact, csp: { ...notesArtifact.csp, fontSrc: [fonts] } }
		const withFonts = { ...access([]), contract: typeface, contractDigest: contractDigest(typeface) }
		expect(entriesNeedingCurrentProxy(withFonts, OLDER_PROXY_READERS)).toEqual([])
	})
})

describe('a public procedure at a path of its own (http.path)', () => {
	const artifact = compileContract(intakeContract, intakeTables)
	const rowAt = (path: string): ProxyEndpointRow => {
		const row = contractProxyTable(artifact).endpoints.find((candidate) => candidate.id === 'api.intake.register')
		if (row === undefined) throw new Error('the intake fixture has no api.intake.register')
		return { ...row, path }
	}

	test("is a row the current proxy parses; the 0.5.5 parser judges its path as the derived one's, refusing only its kind", () => {
		const own = rowAt('/register')
		expect(proxyEndpointRowSchema.safeParse(own).success).toBe(true)
		// Every branch of the 0.5.5 union refuses the two rows alike: a literal path is a path to it, and `public` no kind.
		const issues = (row: ProxyEndpointRow) => JSON.stringify(proxyEndpointRowSchema05.safeParse(row).error?.issues)
		expect(issues(own)).toBe(issues(rowAt('/api/intake.register')))
		expect(issues(own)).toContain('"received":"public"')
		const approved: ProviderApprovedAccess = {
			contract: artifact,
			contractDigest: contractDigest(artifact),
			schema: schemaFromContract(artifact),
			checker: '0.7.0',
		}
		expect(entriesNeedingCurrentProxy(approved, BEFORE_07)).toContain('api.intake.register')
		expect(entriesNeedingCurrentProxy(approved, OLDER_PROXY_READERS)).not.toContain('api.intake.register')
	})
})

const fixtureSchema = z.object({ files: z.record(z.string()) }).passthrough()

describe.each([
	['the CRM at v0.4.8', 'crm-0.4.8.json', 'crm'],
	['the CRM at v0.5.4', 'crm-0.5.4.json', 'crm'],
	['an application with form files at v0.5.5', 'form-files-0.5.5.json', 'signup'],
	['a GitHub webhook and a job at v0.5.5', 'webhooks-0.5.5.json', 'hooks'],
	['the CRM at v0.6.0', 'crm-0.6.0.json', 'crm'],
	['the CRM at v0.7.0', 'crm-0.7.0.json', 'crm'],
])('%s, for a namespace proxy pinned to an older source', (_name, file, app) => {
	test('deploys: a proxy of the window parses every row', async () => {
		const fixture = fixtureSchema.parse(JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8')))
		const commit = await memoryCommits(fixture.files).open({
			repoUrl: 'github.com/acme/app',
			commitSha: 'c'.repeat(40),
			signal: new AbortController().signal,
		})
		const approved = approvedAccess(await readAccessSnapshot(commit, '', app))
		if (approved === undefined) throw new Error('the snapshot has no contract')
		expect(entriesNeedingCurrentProxy(approved, OLDER_PROXY_READERS)).toEqual([])
	})
})
