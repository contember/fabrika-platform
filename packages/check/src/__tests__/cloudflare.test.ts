// The Cloudflare rules beyond the rule table: which sites `cloudflare-held-call` reaches, and which migrations
// `cloudflare-current-timestamp` refuses. Over the two-slice application, whose deals.create is a mutation and
// deals.pipeline a query.

import type { ContractArtifact } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { checkApplication } from '../check'
import type { RuleId } from '../finding'
import { checkCloudflareContract } from '../rules/cloudflare'
import { scaffoldInputs } from '../scaffold'
import { readTree } from './colocated-helpers'

const CLOUDFLARE_CONFIG =
	"import { defineApp } from '@fabrika/provider-cloudflare'\n\nexport default defineApp({ id: 'notes', resources: () => [] })\n"
const CLOUDFLARE_POSTGRES_CONFIG =
	"import { defineApp } from '@fabrika/provider-cloudflare'\n\nexport default defineApp({ id: 'notes', database: { kind: 'postgres', provisioningSecret: 'DATABASE_URL' }, resources: () => [] })\n"
const DEALS = 'src/deals/endpoints.ts'
const CREATE_ACCESS = "access: { action: 'deals.write', in: 'company', from: 'companyId' } })"
const PIPELINE_ACCESS = "access: { action: 'crm.read', in: 'org', from: 'orgId' }, sql: 'read' })"
const MIGRATION = 'db/migrations/20261024120000_audit.sql'

/** The two-slice application, on Cloudflare when `cloudflare`, with `edit` applied to its deals endpoints. */
const application = (cloudflare: boolean, edit: (text: string) => string = (text) => text): Map<string, string> => {
	const files = readTree(join(import.meta.dir, 'fixtures', 'architecture-app'), ['.fixture', '.sql'])
	const text = files.get(DEALS) ?? ''
	files.set(DEALS, edit(text))
	if (cloudflare) files.set('fabrika.config.ts', CLOUDFLARE_CONFIG)
	return files
}

const findingsOf = async (rule: RuleId, files: ReadonlyMap<string, string>): Promise<string[]> =>
	(await checkApplication({ root: '/application', files }))
		.filter((finding) => finding.rule === rule)
		.map((finding) => `${finding.file}:${finding.line} ${finding.severity} ${finding.message}`)

describe('cloudflare-held-call', () => {
	test('hints on a mutation that declares egress, naming the origin and the paved route', async () => {
		const files = application(true, (text) => text.replace(CREATE_ACCESS, CREATE_ACCESS.replace(' })', ", egress: ['https://api.example.com'] })")))
		const found = await findingsOf('cloudflare-held-call', files)
		expect(found).toEqual([expect.stringContaining('fabrika.contract.ts:1 hint api.deals.create')])
		expect(found[0]).toContain('https://api.example.com')
		expect(found[0]).toContain('whole environment')
	})

	test('hints on a mutation that declares connect', () => {
		const artifact = scaffoldInputs(application(true)).artifact
		if (artifact === null) throw new Error('the fixture compiles no contract')
		const declared = { ...artifact.declared, 'api.deals.create': { sql: null, unscoped: {}, connect: ['catalog'], issues: null } }
		const hints = checkCloudflareContract({ ...artifact, declared }).filter((finding) => finding.rule === 'cloudflare-held-call')
		expect(hints.map((finding) => [finding.severity, finding.message])).toEqual([['hint', expect.stringContaining('api.deals.create')]])
		expect(hints[0]?.message).toContain('catalog')
	})

	test('no hint for a query that declares egress, nor for a mutation on Zerops', async () => {
		const query = application(true, (text) => text.replace(PIPELINE_ACCESS, PIPELINE_ACCESS.replace(' })', ", egress: ['https://api.example.com'] })")))
		expect(query.get(DEALS)).toContain("sql: 'read', egress:")
		expect(await findingsOf('cloudflare-held-call', query)).toEqual([])
		const zerops = application(false, (text) => text.replace(CREATE_ACCESS, CREATE_ACCESS.replace(' })', ", egress: ['https://api.example.com'] })")))
		expect(zerops.get(DEALS)).toContain('egress:')
		expect(await findingsOf('cloudflare-held-call', zerops)).toEqual([])
	})
})

describe('cloudflare-current-timestamp', () => {
	test('refuses DEFAULT CURRENT_TIMESTAMP in any case and parenthesized, at its line, naming the strftime default', async () => {
		const files = application(true)
		files.set(
			MIGRATION,
			'create table audit (\n\tid text primary key,\n\tat timestamp not null default current_timestamp,\n\tseen timestamp default (CURRENT_TIMESTAMP)\n);\n',
		)
		const found = await findingsOf('cloudflare-current-timestamp', files)
		expect(found).toEqual([expect.stringContaining(`${MIGRATION}:3 refusal`), expect.stringContaining(`${MIGRATION}:4 refusal`)])
		expect(found[0]).toContain('unexpected_row')
	})

	test('no refusal on Postgres, nor for the strftime default', async () => {
		const postgres = application(false)
		postgres.set(MIGRATION, 'create table audit (id uuid primary key, at timestamptz not null default current_timestamp);\n')
		expect(await findingsOf('cloudflare-current-timestamp', postgres)).toEqual([])
		const cloudflare = application(true)
		cloudflare.set(MIGRATION, "create table audit (id text primary key, at timestamp not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));\n")
		expect(await findingsOf('cloudflare-current-timestamp', cloudflare)).toEqual([])
	})
})

describe('cloudflare-job-segment', () => {
	test('refuses a job longer than one 14-minute segment, naming the job, its timeout, the cap and the chunking form', () => {
		const artifact = scaffoldInputs(application(true)).artifact
		if (artifact === null) throw new Error('the fixture compiles no contract')
		const job = (timeoutMs: number) => ({ schedule: '0 3 * * *', actions: [], scope: { kind: 'app' as const }, timeoutMs, retries: 0 })
		const refusals = checkCloudflareContract({ ...artifact, jobs: { nightly: job(14 * 60_000 + 1), hourly: job(14 * 60_000) } })
			.filter((finding) => finding.rule === 'cloudflare-job-segment')
		expect(refusals.map((finding) => [finding.severity, finding.message])).toEqual([
			['refusal', 'the job nightly runs up to 840001 ms, and a job segment on Cloudflare runs at most 840000 ms'],
		])
		expect(refusals[0]?.allowed).toContain('claim')
		expect(refusals[0]?.allowed).toContain('backlog 230')
	})
})

describe('an application on Cloudflare over Postgres (Hyperdrive)', () => {
	const postgres = (edit?: (text: string) => string): Map<string, string> => {
		const files = application(false, edit)
		files.set('fabrika.config.ts', CLOUDFLARE_POSTGRES_CONFIG)
		return files
	}

	test('keeps the contract refusals, drops the held-call hint', () => {
		const artifact = scaffoldInputs(postgres()).artifact
		if (artifact === null) throw new Error('the fixture compiles no contract')
		const declared = { ...artifact.declared, 'api.deals.create': { sql: null, unscoped: {}, connect: ['catalog'], issues: null } }
		const fileKinds: ContractArtifact['fileKinds'] = { avatar: { types: ['image/png'], maxBytes: 1024, scan: true } }
		const rules = (database: 'postgres' | 'sqlite') =>
			new Set(checkCloudflareContract({ ...artifact, declared, fileKinds }, { database }).map((finding) => finding.rule))
		expect(rules('postgres')).toEqual(new Set(['cloudflare-scan']))
		expect(rules('sqlite')).toEqual(new Set(['cloudflare-scan', 'cloudflare-held-call']))
	})

	test('runs no SQLite migration rule and no held-call hint', async () => {
		const files = postgres((text) => text.replace(CREATE_ACCESS, CREATE_ACCESS.replace(' })', ", egress: ['https://api.example.com'] })")))
		files.set(MIGRATION, 'create table audit (id uuid primary key, at timestamptz not null default current_timestamp);\n')
		files.set('db/migrations/20261024120001_view.sql', 'create view leases as select * from fabrika_job_leases;\n')
		const found = (await checkApplication({ root: '/application', files })).map((finding) => finding.rule)
		expect(found.filter((rule) => rule.startsWith('cloudflare-'))).toEqual([])
	})
})
