// A cron job that issues share links (WU15): `issues: '<link mount>'` on `app.cron` is a declared reach, checked by
// `buildArtifact` against the job's actions, carried into IAM's schema as the job's `issues`, and the only way to a job's
// `ctx.links`. IAM decides each issuance (packages/iam's job-links.test.ts); here IAM is a recording stand-in.

import { compileContract, ContractError, defineApp, schemaFromContract } from '@fabrika/app/contract'
import {
	BootError,
	CapabilityRefusedError,
	type ContractImplementation,
	type JobClock,
	serve,
	type WorkloadTokenSource,
} from '@fabrika/app/implement'
import { parseAccessClaims } from '@fabrika/auth-core'
import { applicationSchema, Database, scoped } from '@fabrika/db'
import { FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'
import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { decodeJwt } from 'jose'
import { z } from 'zod/v4'
import type { LinkIssuing } from '../implement/membership'
import { bootApp, environment, frameworkEnvFor, grant, ISSUER, resultOf, send, token, workloadTokensFor } from './fixtures/implement/harness'
import { RecordingMembership } from './fixtures/multi-tenant/iam'
import { tables } from './kit-fixture/src/db/tables'
import { Deal } from './kit-fixture/src/schemas'
import { vocabulary } from './kit-fixture/src/vocabulary'
import { migration } from './orm-fixture/migration'

const DEAL = '0190a0a0-0000-7000-8000-0000000000e1'
const app = defineApp(vocabulary, tables)

const shared = app.link('/s', {
	spa: 'dist/share',
	dimension: 'deal',
	grants: ['crm.read'],
	issuedBy: 'deals.share',
	maxDays: 30,
	procedures: (l) => ({
		deal: l.query({ output: Deal, access: { action: 'crm.read' } }).handle(async ({ ctx }) => {
			const deal = await ctx.db.target.get()
			return { id: deal.id, title: deal.title, stage: deal.stage }
		}),
	}),
})

/** What the issuing job saw, for the test to read. */
const seen: { issued: { id: string; url: string } | null; links: boolean | null; kept: LinkIssuing<string, string, string> | null } = {
	issued: null,
	links: null,
	kept: null,
}

const invite = app.cron('* * * * *', { actions: ['crm.read', 'deals.share'], scope: 'app', issues: 'shared' }).handle(async ({ ctx }) => {
	const issued = await ctx.links.issue(await ctx.ref('deals.share', 'deal', DEAL), { mount: 'shared', days: 3 })
	seen.issued = { id: issued.id, url: issued.url }
	seen.kept = ctx.links
	await ctx.links.revoke(issued.id)
})

const quiet = app.cron('0 3 * * *', { actions: ['crm.read'], scope: 'app' }).handle(({ ctx }) => {
	seen.links = 'links' in ctx
})

const Unshare = z.strictObject({ id: z.uuid(), linkId: z.string() })
const Done = z.strictObject({ ok: z.boolean() })

const deals = app.group({ callers: ['human'] }, (r) => ({
	unshare: r.mutation({ input: Unshare, output: Done, access: { action: 'deals.share', on: 'deal', from: 'id' }, issues: 'shared' })
		.handle(async ({ input, ctx }) => {
			await ctx.links.revoke(input.linkId)
			return { ok: true }
		}),
}))

const contract = app.contract((c) => ({ api: c.rpc('/api', { deals }), shared, jobs: { invite, quiet } }))

function refusals(work: () => unknown): readonly string[] {
	try {
		work()
	} catch (error) {
		if (error instanceof ContractError || error instanceof BootError) return error.problems
		throw error
	}
	return []
}

describe('a job declares the link mount it issues', () => {
	test('the artifact records it under the job, and IAM learns it with the job', () => {
		const artifact = compileContract(contract, tables)
		expect(artifact.declared?.['job:invite']).toEqual({ sql: null, unscoped: {}, connect: [], issues: 'shared' })
		expect(artifact.declared?.['job:quiet']).toBeUndefined()
		expect(schemaFromContract(artifact).workloads).toEqual([
			{ kind: 'job', name: 'invite', actions: ['crm.read', 'deals.share'], issues: 'shared' },
			{ kind: 'job', name: 'quiet', actions: ['crm.read'] },
		])
	})

	test("only a link mount of the contract, whose issuedBy and every grant are the job's actions", () => {
		const short = app.cron('* * * * *', { actions: ['deals.share'], scope: 'app', issues: 'shared' }).handle(async () => {})
		const unknown = app.cron('* * * * *', { actions: ['crm.read', 'deals.share'], scope: 'app', issues: 'elsewhere' }).handle(async () => {})
		const refused = app.contract(() => ({ shared, jobs: { short, unknown } }))
		expect(refusals(() => compileContract(refused, tables))).toEqual([
			"job 'short': issues 'shared', whose links need 'crm.read' among the job's actions",
			"job 'unknown': issues 'elsewhere', which is not a link mount of the contract",
		])
	})
})

const URL_VARIABLE = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VARIABLE] ?? ''
const hasPostgres = url !== ''
if (!hasPostgres) {
	console.warn(`job-links.test.ts: the job runs skipped; set ${URL_VARIABLE} to run them (a job's lease lives in @fabrika/db)`)
}
const schema = applicationSchema(`joblinks-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`)
const connections: Database[] = []

async function admin(statement: string): Promise<void> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		await sql.unsafe(statement)
	} finally {
		await sql.close()
	}
}

beforeAll(async () => {
	if (!hasPostgres) return
	const framework = FRAMEWORK_MIGRATIONS.map((file) => file.sql).join('\n')
	await admin(`create schema ${schema}; set search_path to ${schema}; ${framework} ${migration}`)
	await admin(`insert into ${schema}.orgs (id, name, created_by, version) values ('o1', 'One', 'u', 1)`)
	await admin(`insert into ${schema}.companies (id, org_id, name, created_by, version) values ('c1', 'o1', 'Acme', 'u', 1)`)
	await admin(
		`insert into ${schema}.deals (id, company_id, org_id, title, stage, created_by, version) values ('${DEAL}', 'c1', 'o1', 'Deal', 'won', 'u', 1)`,
	)
})

afterAll(async () => {
	if (!hasPostgres) return
	for (const connection of connections) await connection.close()
	await admin(`drop schema ${schema} cascade`)
})

function implementation(): ContractImplementation {
	return serve(contract, { database: scoped(tables) })
}

function booted(iam: RecordingMembership | undefined, tokens?: (served: ContractImplementation) => WorkloadTokenSource) {
	const served = implementation()
	const connection = Database.postgres({ url, schema, max: 2 })
	connections.push(connection)
	return bootApp(served, {
		environment: environment({ ...frameworkEnvFor(served), FABRIKA_IAM_APP_ID: 'crm@prod' }),
		workloadTokens: tokens?.(served) ?? workloadTokensFor(served, undefined, ISSUER, 'crm@prod'),
		database: connection,
		...(iam === undefined ? {} : { membership: iam }),
	})
}

const noReports = { report: () => Promise.resolve() }

/**
 * Tokens that expire inside the refresh skew, so every authority lookup exchanges the key; the exchange numbered `held`
 * waits until the test releases it.
 */
function heldExchange(held: number) {
	const reached = Promise.withResolvers<void>()
	const released = Promise.withResolvers<void>()
	let exchanges = 0
	const source = (served: ContractImplementation): WorkloadTokenSource => {
		const tokens = workloadTokensFor(served, undefined, ISSUER, 'crm@prod', 20)
		return {
			async exchange(input) {
				exchanges++
				if (exchanges === held) {
					reached.resolve()
					await released.promise
				}
				return tokens.exchange(input)
			},
		}
	}
	return { source, reached: reached.promise, release: () => released.resolve() }
}

/** Instant backoff; the attempt's deadline passes only when the test calls `pass`. */
function deadlineClock(): { readonly clock: JobClock; pass(): void } {
	const deadlines: (() => void)[] = []
	const clock: JobClock = {
		wait: (ms, signal) =>
			new Promise<void>((resolve) => {
				if (ms < 60_000 || signal.aborted) {
					resolve()
					return
				}
				deadlines.push(resolve)
				signal.addEventListener('abort', () => resolve(), { once: true })
			}),
		random: () => 0,
	}
	return { clock, pass: () => deadlines.splice(0).forEach((resolve) => resolve()) }
}

describe.skipIf(!hasPostgres)("a job's ctx.links", () => {
	test("issues for the job's Ref with its own token and the whole chain, and revokes what it issued", async () => {
		const iam = new RecordingMembership()
		const result = await booted(iam).jobs.run('invite', { reporter: noReports })
		expect(result).toEqual({ status: 'succeeded', attempts: 1 })
		expect(seen.issued).toEqual({ id: 'link-1', url: '/s/#px_sharedkey123' })
		const [issue, revoke] = iam.calls
		if (issue?.method !== 'issueLink' || revoke?.method !== 'revokeLink') throw new Error(`unexpected calls: ${JSON.stringify(iam.calls)}`)
		expect({ mount: issue.input.mount, chain: issue.input.chain, days: issue.input.days }).toEqual({
			mount: 'shared',
			chain: [{ type: 'deal', value: DEAL }, { type: 'company', value: 'c1' }, { type: 'org', value: 'o1' }],
			days: 3,
		})
		const claims = parseAccessClaims(decodeJwt(issue.input.credential ?? ''))
		expect({ ptype: claims?.ptype, workload: claims?.workload }).toEqual({ ptype: 'job', workload: 'invite' })
		expect(revoke.input).toMatchObject({ id: 'link-1', credential: issue.input.credential, requestId: issue.input.requestId })
	})

	test('ctx.links kept past its attempt asks IAM nothing', async () => {
		const iam = new RecordingMembership()
		expect(await booted(iam).jobs.run('invite', { reporter: noReports })).toEqual({ status: 'succeeded', attempts: 1 })
		const calls = iam.calls.length
		await expect(seen.kept?.revoke('link-1') ?? Promise.resolve()).rejects.toBeInstanceOf(CapabilityRefusedError)
		expect(iam.calls).toHaveLength(calls)
	})

	test.each<{ readonly operation: string; readonly held: number; readonly before: RecordingMembership['calls'][number]['method'][] }>([
		{ operation: 'issueLink', held: 2, before: [] },
		{ operation: 'revokeLink', held: 3, before: ['issueLink'] },
	])('an attempt that times out while ctx.links looks up its token sends IAM no $operation', async ({ held, before }) => {
		const iam = new RecordingMembership()
		const lookup = heldExchange(held)
		const deadline = deadlineClock()
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			const app = booted(iam, lookup.source)
			const run = app.jobs.run('invite', { reporter: noReports, clock: deadline.clock })
			await lookup.reached
			deadline.pass()
			expect(await run).toMatchObject({ status: 'failed', code: 'timeout' })
			lookup.release()
			await Bun.sleep(50)
		} finally {
			log.mockRestore()
		}
		expect(iam.calls.map((call) => call.method)).toEqual(before)
	})

	test('IAM refusing the issuance fails the attempt, and a job without issues has no ctx.links', async () => {
		const iam = new RecordingMembership()
		iam.refuse = { ok: false, reason: 'not_allowed' }
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			const app = booted(iam)
			expect(await app.jobs.run('invite', { reporter: noReports })).toMatchObject({ status: 'failed', code: 'handler_failed' })
			expect(await app.jobs.run('quiet', { reporter: noReports })).toEqual({ status: 'succeeded', attempts: 1 })
		} finally {
			log.mockRestore()
		}
		expect(seen.links).toBe(false)
	})

	test("an endpoint's ctx.links.revoke asks IAM with the caller's token", async () => {
		const iam = new RecordingMembership()
		const sharer = await token('user', [grant('deals.share', { type: 'org', value: 'o1' })], 'crm@prod')
		const headers = { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-Request-Id': 'req-unshare' }
		const sent = await send(booted(iam), '/api/deals.unshare', { token: sharer, body: { id: DEAL, linkId: 'link-7' }, headers })
		expect(resultOf(sent)).toEqual({ ok: true })
		expect(iam.calls).toEqual([{ method: 'revokeLink', input: { app: 'crm@prod', credential: sharer, requestId: 'req-unshare', id: 'link-7' } }])
	})

	test('a job that issues does not boot without an IAM membership transport', () => {
		expect(refusals(() => booted(undefined))).toContain(
			"job 'invite' issues links of 'shared', and the runtime adapter supplies no IAM membership transport (the IAM binding on Cloudflare; FABRIKA_IAM_RPC_URL and FABRIKA_IAM_RPC_KEY on Bun)",
		)
	})
})
