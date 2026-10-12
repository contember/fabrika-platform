// A job that issues share links (WU15): IAM admits a job's token on `issueLink` and `revokeLink` only while the app's
// reconciled schema declares that the job issues that link mount, and on no other membership operation. The
// declaration is the approved artifact's, reconciled into `app_workloads.issues`.

import { type AppSchema, type MembershipCaller, type MembershipFailure, parseAccessClaims, type Scope } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { decodeJwt } from 'jose'
import { createIamRepositories, CredentialRepository } from '../db'
import { assignMember, createScope, issueLink, listMembers, requestDelegation, revokeLink, revokeMember } from '../membership'
import { mintFromKey } from '../tokens'
import { createHarness, TEST_SIGNING_ENV, TestSqlDatabase } from './helpers/harness'
import { APP, CALLER_ENV, INVITE_ENDPOINT, type MembershipFixture, membershipFixture, NOTES_SCHEMA } from './helpers/membership'

const LINKS: AppSchema['links'] = {
	...NOTES_SCHEMA.links,
	published: { dimension: 'note', grants: ['notes.read'], issuedBy: 'notes.share', maxDays: 7 },
}

const WORKLOADS: AppSchema['workloads'] = [
	{ kind: 'job', name: 'intake', actions: ['notes.read', 'notes.share'], issues: 'shared' },
	{ kind: 'job', name: 'nightly', actions: ['notes.read', 'notes.share'] },
	{ kind: 'webhook', name: 'github', actions: ['notes.read', 'notes.share'] },
]

const SCHEMA: AppSchema = { ...NOTES_SCHEMA, links: LINKS, workloads: WORKLOADS }

const CHAIN: Scope[] = [{ type: 'note', value: 'n1' }, { type: 'workspace', value: 'w1' }]

let requestSeq = 0

async function fixture(): Promise<MembershipFixture> {
	const f = await membershipFixture(createHarness().repositories)
	const reconciled = await f.putSchema(SCHEMA)
	if (reconciled.status !== 200) throw new Error(`schema refused: ${await reconciled.text()}`)
	return f
}

function as(credential: string, app = APP): MembershipCaller {
	requestSeq += 1
	return { app, credential, requestId: `req-job-${requestSeq}` }
}

describe('a job that declares issues', () => {
	test('issues a link of its mount, bound to the chain, with the job as its issuer', async () => {
		const f = await fixture()
		const job = await f.workload('job', 'intake')
		const issued = await issueLink(f.services, CALLER_ENV, f.ctx, { ...as(await job.token()), mount: 'shared', chain: CHAIN, days: 7 })
		if (!issued.ok) throw new Error(`expected a link: ${issued.reason}`)
		expect((await f.repositories.credentials.getCredentialById(issued.id))?.issued_by).toBe(job.id)
		const minted = await mintFromKey(f.services, TEST_SIGNING_ENV, { app: APP, key: issued.key, requestId: 'req-holder' })
		if (!minted.result.ok) throw new Error('expected a link token')
		const claims = parseAccessClaims(decodeJwt(minted.result.token))
		expect(claims?.link).toEqual({ mount: 'shared', chain: CHAIN })
		expect(claims?.perms).toEqual([{ action: 'notes.read', scope: { type: 'note', value: 'n1' }, source: 'grant' }])
		const events = await f.repositories.audit.listAuditEvents({ action: 'iam.link.issue', limit: 10 })
		expect(events.map((event) => [event.principal_id, event.resource_id])).toEqual([[job.id, issued.id]])
	})

	test('issues with its key as well as with its token', async () => {
		const f = await fixture()
		const job = await f.workload('job', 'intake')
		const issued = await issueLink(f.services, CALLER_ENV, f.ctx, { ...as(job.key), mount: 'shared', chain: CHAIN, days: 1 })
		expect(issued.ok).toBe(true)
	})

	test('issues no link of another mount, and none past the mount maxDays', async () => {
		const f = await fixture()
		const job = await f.workload('job', 'intake')
		expect(await issueLink(f.services, CALLER_ENV, f.ctx, { ...as(await job.token()), mount: 'published', chain: CHAIN, days: 1 })).toEqual({
			ok: false,
			reason: 'not_allowed',
		})
		expect(await issueLink(f.services, CALLER_ENV, f.ctx, { ...as(await job.token()), mount: 'shared', chain: CHAIN, days: 31 })).toMatchObject({
			reason: 'invalid_request',
		})
	})

	test('revokes a link it issued, and no link another issuer did, nor one of another mount', async () => {
		const f = await fixture()
		const job = await f.workload('job', 'intake')
		const own = await issueLink(f.services, CALLER_ENV, f.ctx, { ...as(await job.token()), mount: 'shared', chain: CHAIN, days: 1 })
		const owner = await f.person('owner')
		await f.repositories.grants.createGrant({ principalId: owner.id, app: APP, permissions: ['notes.read', 'notes.share'] })
		const byOwner = await issueLink(f.services, CALLER_ENV, f.ctx, { ...as(await owner.token()), mount: 'shared', chain: CHAIN, days: 1 })
		const published = await issueLink(f.services, CALLER_ENV, f.ctx, { ...as(await owner.token()), mount: 'published', chain: CHAIN, days: 1 })
		if (!own.ok || !byOwner.ok || !published.ok) throw new Error('expected links')

		expect(await revokeLink(f.services, CALLER_ENV, f.ctx, { ...as(await job.token()), id: byOwner.id })).toEqual({ ok: false, reason: 'not_allowed' })
		expect(await revokeLink(f.services, CALLER_ENV, f.ctx, { ...as(await job.token()), id: published.id })).toEqual({
			ok: false,
			reason: 'not_allowed',
		})
		expect(await revokeLink(f.services, CALLER_ENV, f.ctx, { ...as(await job.token()), id: own.id })).toEqual({ ok: true })
		expect((await mintFromKey(f.services, TEST_SIGNING_ENV, { app: APP, key: own.key, requestId: 'r' })).result).toEqual({
			ok: false,
			reason: 'invalid_key',
		})
		expect((await mintFromKey(f.services, TEST_SIGNING_ENV, { app: APP, key: byOwner.key, requestId: 'r' })).result.ok).toBe(true)
	})
})

describe('IAM refuses a workload that may not issue', () => {
	test('a job without the declaration issues nothing', async () => {
		const f = await fixture()
		const job = await f.workload('job', 'nightly')
		expect(await issueLink(f.services, CALLER_ENV, f.ctx, { ...as(await job.token()), mount: 'shared', chain: CHAIN, days: 1 })).toEqual({
			ok: false,
			reason: 'not_allowed',
		})
	})

	test('a job whose declaration was removed issues and revokes nothing, its earlier link intact', async () => {
		const f = await fixture()
		const job = await f.workload('job', 'intake')
		const token = await job.token()
		const issued = await issueLink(f.services, CALLER_ENV, f.ctx, { ...as(token), mount: 'shared', chain: CHAIN, days: 1 })
		if (!issued.ok) throw new Error('expected a link')
		const without = WORKLOADS.map((workload) => (workload.kind === 'job' && workload.name === 'intake' ? { ...workload, issues: undefined } : workload))
		expect((await f.putSchema({ ...SCHEMA, workloads: without })).status).toBe(200)
		// The token was signed before the reconcile and still verifies; IAM reads the declaration as it is now.
		expect(await issueLink(f.services, CALLER_ENV, f.ctx, { ...as(token), mount: 'shared', chain: CHAIN, days: 1 })).toEqual({
			ok: false,
			reason: 'not_allowed',
		})
		expect(await revokeLink(f.services, CALLER_ENV, f.ctx, { ...as(token), id: issued.id })).toEqual({ ok: false, reason: 'not_allowed' })
		expect((await mintFromKey(f.services, TEST_SIGNING_ENV, { app: APP, key: issued.key, requestId: 'r' })).result.ok).toBe(true)
	})

	test("a job's token or key presented for another app is refused", async () => {
		const f = await fixture()
		const job = await f.workload('job', 'intake')
		for (const credential of [await job.token(), job.key]) {
			expect(await issueLink(f.services, CALLER_ENV, f.ctx, { ...as(credential, 'notes@stage'), mount: 'shared', chain: CHAIN, days: 1 })).toEqual({
				ok: false,
				reason: 'invalid_token',
			})
		}
	})

	test("a webhook's token issues and revokes nothing", async () => {
		const f = await fixture()
		const webhook = await f.workload('webhook', 'github')
		const token = await webhook.token()
		expect(await issueLink(f.services, CALLER_ENV, f.ctx, { ...as(token), mount: 'shared', chain: CHAIN, days: 1 })).toEqual({
			ok: false,
			reason: 'invalid_token',
		})
		expect(await revokeLink(f.services, CALLER_ENV, f.ctx, { ...as(token), id: 'any' })).toEqual({ ok: false, reason: 'invalid_token' })
	})

	test('a job that issues still calls no other membership operation', async () => {
		const f = await fixture()
		const job = await f.workload('job', 'intake')
		const workspace: Scope = { type: 'workspace', value: 'w1' }
		for (const credential of [await job.token(), job.key]) {
			const refused: MembershipFailure = { ok: false, reason: 'invalid_token' }
			expect(await requestDelegation(f.services, CALLER_ENV, f.ctx, { ...as(credential), endpoint: INVITE_ENDPOINT })).toEqual(refused)
			expect(await createScope(f.services, CALLER_ENV, f.ctx, { ...as(credential), delegation: 'none', dimension: 'workspace' })).toEqual(refused)
			expect(
				await assignMember(f.services, CALLER_ENV, f.ctx, {
					...as(credential),
					delegation: 'none',
					scope: workspace,
					role: 'editor',
					member: { email: 'someone@example.test' },
				}),
			).toEqual(refused)
			expect(
				await revokeMember(f.services, CALLER_ENV, f.ctx, { ...as(credential), delegation: 'none', scope: workspace, member: { principalId: job.id } }),
			).toEqual(refused)
			expect(await listMembers(f.services, CALLER_ENV, f.ctx, { ...as(credential), scope: workspace })).toEqual(refused)
		}
	})
})

describe('the schema declares what a job issues', () => {
	test('only a link mount of the schema, whose issuedBy and every grant the job holds', async () => {
		const f = await fixture()
		const status = async (workloads: AppSchema['workloads']) => (await f.putSchema({ ...SCHEMA, workloads })).status
		expect(await status([{ kind: 'job', name: 'intake', actions: ['notes.read', 'notes.share'], issues: 'missing' }])).toBe(400)
		expect(await status([{ kind: 'job', name: 'intake', actions: ['notes.share'], issues: 'shared' }])).toBe(400)
		expect(await status([{ kind: 'job', name: 'intake', actions: ['notes.read'], issues: 'shared' }])).toBe(400)
		expect(await status([{ kind: 'job', name: 'intake', actions: ['notes.read', 'notes.share'], issues: 'shared' }])).toBe(200)
	})
})

/** A credential repository that runs `before` once, right before the next link is written: a reconcile in between. */
class ReconcileBeforeWrite extends CredentialRepository {
	before: (() => Promise<void>) | null = null

	override async createLinkCredential(...args: Parameters<CredentialRepository['createLinkCredential']>): Promise<string | null> {
		const before = this.before
		this.before = null
		await before?.()
		return super.createLinkCredential(...args)
	}
}

async function racingFixture() {
	const h = createHarness()
	const credentials = new ReconcileBeforeWrite(new TestSqlDatabase(h.sqlite))
	const f = await membershipFixture(createIamRepositories(new TestSqlDatabase(h.sqlite), { credentials }))
	const reconciled = await f.putSchema(SCHEMA)
	if (reconciled.status !== 200) throw new Error(`schema refused: ${await reconciled.text()}`)
	return { f, credentials, h }
}

describe('a reconcile between the checks and the write of a link', () => {
	test("that shortens the mount's lifetime writes no link for the job", async () => {
		const { f, credentials, h } = await racingFixture()
		const job = await f.workload('job', 'intake')
		const token = await job.token()
		credentials.before = async () => {
			const shorter = { ...LINKS, shared: { dimension: 'note', grants: ['notes.read'], issuedBy: 'notes.share', maxDays: 1 } }
			expect((await f.putSchema({ ...SCHEMA, links: shorter })).status).toBe(200)
		}
		expect(await issueLink(f.services, CALLER_ENV, f.ctx, { ...as(token), mount: 'shared', chain: CHAIN, days: 7 })).toEqual({
			ok: false,
			reason: 'not_allowed',
		})
		expect(h.sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM credentials WHERE link_mount IS NOT NULL').get()?.n).toBe(0)
	})

	test("that changes the mount's grants or the job's actions writes no link", async () => {
		const { f, credentials } = await racingFixture()
		const job = await f.workload('job', 'intake')
		const token = await job.token()
		credentials.before = async () => {
			const wider = { ...LINKS, shared: { dimension: 'note', grants: ['notes.read', 'notes.write'], issuedBy: 'notes.share', maxDays: 30 } }
			const workloads: AppSchema['workloads'] = [{
				kind: 'job',
				name: 'intake',
				actions: ['notes.read', 'notes.share', 'notes.write'],
				issues: 'shared',
			}]
			expect((await f.putSchema({ ...SCHEMA, links: wider, workloads })).status).toBe(200)
		}
		expect(await issueLink(f.services, CALLER_ENV, f.ctx, { ...as(token), mount: 'shared', chain: CHAIN, days: 7 })).toEqual({
			ok: false,
			reason: 'not_allowed',
		})
		// With nothing changed in between, the same issuance is written.
		expect((await issueLink(f.services, CALLER_ENV, f.ctx, { ...as(await job.token()), mount: 'shared', chain: CHAIN, days: 7 })).ok).toBe(true)
	})

	test("that changes the chain's containment writes no link for a person either", async () => {
		const { f, credentials } = await racingFixture()
		const owner = await f.person('owner')
		await f.repositories.grants.createGrant({ principalId: owner.id, app: APP, permissions: ['notes.read', 'notes.share'] })
		credentials.before = async () => {
			const flat = SCHEMA.scopes.map((scope) => (scope.type === 'note' ? { type: 'note' } : scope))
			const links = { shared: { dimension: 'note', grants: ['notes.read'], issuedBy: 'notes.share', maxDays: 30 } }
			expect((await f.putSchema({ ...SCHEMA, scopes: flat, links })).status).toBe(200)
		}
		expect(await issueLink(f.services, CALLER_ENV, f.ctx, { ...as(await owner.token()), mount: 'shared', chain: CHAIN, days: 7 })).toEqual({
			ok: false,
			reason: 'not_allowed',
		})
	})
})
