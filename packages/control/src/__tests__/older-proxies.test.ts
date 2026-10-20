// A Zerops namespace pinned to an older proxy source runs that release's strict manifest parser. A deploy is refused
// only for a row no proxy of the window reads (`rowsNeedingCurrentProxy`), judged by those releases' own parsers: every
// row form this release added is refused, and every row a 0.4 or 0.5 application compiles to deploys.

import { type BodyAdmission, type ContractArtifact, contractDigest, type EndpointRow } from '@fabrika/auth-core'
import type { ProviderApprovedAccess } from '@fabrika/provider-contract'
import { rowsNeedingCurrentProxy } from '@fabrika/provider-zerops'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { schemaFromContract } from '../../../app/src/contract/platform'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { readAccessSnapshot } from '../approval/read'
import { approvedAccess } from '../approval/snapshot'
import { OLDER_PROXY_ROW_READERS } from '../zerops/older-proxies'
import { memoryCommits } from './helpers/commits'

const access = (endpoints: readonly EndpointRow[]): ProviderApprovedAccess => {
	const contract: ContractArtifact = { ...notesArtifact, endpoints: [...notesArtifact.endpoints, ...endpoints] }
	return { contract, contractDigest: contractDigest(contract), schema: schemaFromContract(contract), checker: '0.6.0' }
}

const mount: EndpointRow['source'] = { kind: 'mount', name: 'api' }
const empty: EndpointRow['input'] = { type: 'object', fields: {} }
const json: BodyAdmission = { contentTypes: ['application/json'], maxBytes: 1024 }

describe('the rows of this release, for a namespace proxy pinned to an older source', () => {
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
	])('refuses %s, which no older proxy parses', (_name, row) => {
		expect(rowsNeedingCurrentProxy(access([row]), OLDER_PROXY_ROW_READERS)).toEqual([row.id])
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
		expect(rowsNeedingCurrentProxy(access([row]), OLDER_PROXY_ROW_READERS)).toEqual([])
	})

	test('deploys an application of this release that uses none of them', () => {
		expect(rowsNeedingCurrentProxy(access([]), OLDER_PROXY_ROW_READERS)).toEqual([])
	})
})

const fixtureSchema = z.object({ files: z.record(z.string()) }).passthrough()

describe.each([
	['the CRM at v0.4.8', 'crm-0.4.8.json', 'crm'],
	['the CRM at v0.5.4', 'crm-0.5.4.json', 'crm'],
	['an application with form files at v0.5.5', 'form-files-0.5.5.json', 'signup'],
	['a GitHub webhook and a job at v0.5.5', 'webhooks-0.5.5.json', 'hooks'],
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
		expect(rowsNeedingCurrentProxy(approved, OLDER_PROXY_ROW_READERS)).toEqual([])
	})
})
