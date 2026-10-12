/**
 * The member directory of an endpoint BELOW its dimension (`ctx.members` of a deal endpoint, read from the org's
 * directory), end to end: the production proxy decision mints from the REAL IAM, the application's `boot` resolves the
 * deal's chain from Postgres and asks the same IAM's `findMember` and `listMembers` with the caller's token, and IAM
 * decides from the caller's live permissions. The application is `packages/app`'s members fixture: org → company →
 * deal, the org declaring its members with `directory: 'labels'`.
 *
 * It lives OUTSIDE `src/` for the reason `member-directory.test.ts` does: it reaches into three other packages. Skips
 * cleanly when FABRIKA_TEST_POSTGRES_URL is unset.
 */

import { schemaFromContract } from '@fabrika/app/contract'
import { boot, type ContractApp, serve } from '@fabrika/app/implement'
import { type ContractArtifact, contractDigest, FABRIKA_CONTRACT_DIGEST, FABRIKA_IAM_APP_ID, FABRIKA_IAM_ISSUER } from '@fabrika/auth-core'
import { scoped } from '@fabrika/db'
import { type IsolationWorlds, testDatabase } from '@fabrika/db/testing'
import { MemoryTokenCache, stripFabrikaCookies } from '@fabrika/proxy-core'
import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { contract } from '../../app/src/__tests__/members-fixture/fabrika.contract'
import { tables } from '../../app/src/__tests__/members-fixture/src/db/tables'
import { compileContract } from '../../app/src/contract/compile'
import { endpointProxy } from '../../app/src/testing/proxy'
import { createHarness, TEST_SIGNING_KEYS } from '../../iam/src/__tests__/helpers/harness'
import { APP, type MembershipFixture, membershipFixture, ORIGIN } from '../../iam/src/__tests__/helpers/membership'
import type { Env } from '../../iam/src/env'
import { unixNow } from '../../iam/src/repositories/sql'
import { createIamRpc } from '../../iam/src/rpc'
import { hashToken } from '../../iam/src/secret'

const HOST = 'notes.test'
const postgres = await testDatabase({
	migrations: new URL('../../app/src/__tests__/members-fixture/db/migrations/', import.meta.url),
	label: 'member-lookup.test.ts',
})
afterAll(() => postgres?.close())

const exec = { waitUntil() {} }

const unusedDatabase = {
	prepare(): never {
		throw new Error('database access goes through REPOSITORIES in this test')
	},
	batch(): Promise<never> {
		return Promise.reject(new Error('database access goes through REPOSITORIES in this test'))
	},
}

function iamEnv(f: MembershipFixture): Env {
	return {
		DB: unusedDatabase,
		REPOSITORIES: f.repositories,
		HUMAN_EMAIL_DOMAINS: '[]',
		HUMAN_EMAILS: '[]',
		IAM_BOOTSTRAP_ADMINS: '[]',
		ENVIRONMENT: 'stage',
		ISSUER: ORIGIN,
		FABRIKA_IAM_SIGNING_KEYS: TEST_SIGNING_KEYS,
		OIDC_ISSUER: 'https://idp.test',
		OIDC_CLIENT_ID: 'client',
		OIDC_CLIENT_SECRET: 'secret',
		OIDC_SCOPES: '',
		OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
	}
}

interface Caller {
	readonly id: string
	readonly key: string
	/** The label IAM holds for the person: its address. */
	readonly label: string
}

interface Stack {
	/** One deal in each of two fresh orgs that share no value. */
	seed(): Promise<IsolationWorlds>
	/** A procedure of `api.deals`, with `key` as its bearer, through the proxy into the application. */
	call(key: string, procedure: string, input: object): Promise<{ readonly status: number; readonly body: unknown }>
	/** A person holding `role` in the org of `world`, with a `px_` key of its own. */
	member(worlds: IsolationWorlds, name: string, role: 'manager' | 'viewer', world: 'own' | 'other'): Promise<Caller>
	/** A person holding only `action` on the company of the own deal: no role, no grant on the org. */
	inCompany(worlds: IsolationWorlds, name: string, action: string): Promise<Caller>
	/** A person holding only `action` on the org of the own deal, outside any membership role. */
	inOrg(worlds: IsolationWorlds, name: string, action: string): Promise<Caller>
}

const orgOf = (worlds: IsolationWorlds, world: 'own' | 'other'): string => {
	const org = worlds[world].chain.find((link) => link.type === 'org')
	if (org === undefined) throw new Error('the seeded deal lies in no org')
	return org.value
}

/** IAM with the application's schema, the production proxy in front of it, and its boot: once, as the data layer binds once. */
async function start(): Promise<Stack> {
	if (postgres === null) throw new Error('the stack needs Postgres')
	const f = await membershipFixture(createHarness().repositories)
	// A layer of its own: the fixture's `src/app.ts` is booted by its generated tests, and a layer binds once.
	const served = serve(contract, { database: scoped(tables) })
	const artifact: ContractArtifact = compileContract(contract, served.database?.tables ?? {})
	expect((await f.putSchema(schemaFromContract(artifact))).status).toBe(200)
	const iam = createIamRpc(iamEnv(f), exec)
	const proxy = endpointProxy({ artifact, appId: APP, host: HOST, iam, issuer: ORIGIN, delegations: iam, cache: new MemoryTokenCache() })
	const app: ContractApp = boot(served, {
		environment: {
			framework: { [FABRIKA_IAM_APP_ID]: APP, [FABRIKA_IAM_ISSUER]: ORIGIN, [FABRIKA_CONTRACT_DIGEST]: contractDigest(artifact) },
			application: {},
		},
		iam: { getJwks: () => iam.getJwks() },
		assets: { serve: () => Promise.resolve(new Response('')) },
		database: postgres.database,
		membership: iam,
	})
	let seq = 0
	/** A person of a name no other test uses, with a `px_` key of its own. */
	const person = async (name: string): Promise<{ readonly id: string; readonly name: string; readonly label: string }> => {
		seq += 1
		const unique = `${name}-${seq}`
		return { id: (await f.person(unique)).id, name: unique, label: `${unique}@example.test` }
	}
	const keyed = async ({ id, name, label }: { readonly id: string; readonly name: string; readonly label: string }): Promise<Caller> => {
		const key = `px_member-lookup-${name}-0123456789abcdef`
		await f.repositories.credentials.createCredential({
			tokenHash: await hashToken(key),
			principalId: id,
			app: APP,
			issuedBy: id,
			expiresAt: unixNow() + 3600,
			grants: [],
		})
		return { id, key, label }
	}
	return {
		seed: () => postgres.seedWorlds(tables, 'deals'),
		async call(key, procedure, input) {
			const request = new Request(`https://${HOST}/api/deals.${procedure}`, {
				method: 'POST',
				headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
				body: JSON.stringify(input),
			})
			const outcome = await proxy({ method: request.method, url: request.url, headers: new Headers(request.headers) })
			const response = await (async () => {
				if (outcome.outcome === 'answer') return outcome.response
				const headers = new Headers(request.headers)
				stripFabrikaCookies(headers)
				if (!outcome.keepsAuthorization) headers.delete('authorization')
				for (const [header, value] of outcome.asserted) headers.set(header, value)
				return app.fetch(new Request(request, { headers }))
			})()
			const text = await response.text()
			let body: unknown = text
			try {
				body = JSON.parse(text)
			} catch {
				// A proxy refusal answers plain text.
			}
			return { status: response.status, body }
		},
		async member(worlds, name, role, world) {
			const held = await person(name)
			await f.repositories.membership.grantMembershipRole({
				app: APP,
				principalId: held.id,
				roleKey: role,
				scope: { type: 'org', value: orgOf(worlds, world) },
				grantedBy: held.id,
			})
			return keyed(held)
		},
		async inOrg(worlds, name, action) {
			const held = await person(name)
			await f.repositories.grants.createGrant({
				principalId: held.id,
				app: APP,
				permissions: [action],
				scopeType: 'org',
				scopeValue: orgOf(worlds, 'own'),
			})
			return keyed(held)
		},
		async inCompany(worlds, name, action) {
			const held = await person(name)
			const company = worlds.own.chain.find((link) => link.type === 'company')
			if (company === undefined) throw new Error('the seeded deal lies in no company')
			await f.repositories.grants.createGrant({ principalId: held.id, app: APP, permissions: [action], scopeType: 'company', scopeValue: company.value })
			return keyed(held)
		},
	}
}

let started: Promise<Stack> | undefined
const stack = (): Promise<Stack> => {
	started ??= start()
	return started
}

const Result = z.strictObject({ result: z.unknown() })
const Found = z.strictObject({ member: z.nullable(z.strictObject({ principalId: z.string(), label: z.nullable(z.string()) })) })
const Owner = z.strictObject({ owner: z.nullable(z.string()), ownerLabel: z.nullable(z.string()) })
const Team = z.strictObject({ members: z.array(z.strictObject({ principalId: z.string(), label: z.nullable(z.string()) })) })

describe.skipIf(postgres === null)("ctx.members of a deal endpoint reads the org's directory, through the proxy and IAM", () => {
	test("the lookup answers a member of the deal's org with its label, and null for a non-member and a member of another org", async () => {
		const s = await stack()
		const worlds = await s.seed()
		const manager = await s.member(worlds, 'manager', 'manager', 'own')
		const viewer = await s.member(worlds, 'viewer', 'viewer', 'own')
		const elsewhere = await s.member(worlds, 'elsewhere', 'viewer', 'other')
		const ask = async (principalId: string) => {
			const answered = await s.call(manager.key, 'candidate', { id: worlds.own.key, principalId })
			expect(answered.status).toBe(200)
			return Found.parse(Result.parse(answered.body).result).member
		}
		expect(await ask(viewer.id)).toEqual({ principalId: viewer.id, label: viewer.label })
		expect(await ask(elsewhere.id)).toBeNull()
		expect(await ask(crypto.randomUUID())).toBeNull()
	})

	test("an assignment stores the directory's label and refuses a person outside the org", async () => {
		const s = await stack()
		const worlds = await s.seed()
		const manager = await s.member(worlds, 'manager', 'manager', 'own')
		const viewer = await s.member(worlds, 'viewer', 'viewer', 'own')
		const elsewhere = await s.member(worlds, 'elsewhere', 'viewer', 'other')
		const refused = await s.call(manager.key, 'assign', { id: worlds.own.key, expectVersion: 1, newOwner: elsewhere.id })
		expect(refused.status).toBe(400)
		expect(JSON.stringify(refused.body)).toContain('the owner is not a member of the org')
		expect((await s.call(manager.key, 'assign', { id: worlds.own.key, expectVersion: 1, newOwner: viewer.id })).status).toBe(200)
		const owner = Owner.parse(Result.parse((await s.call(manager.key, 'owner', { id: worlds.own.key })).body).result)
		expect(owner).toEqual({ owner: viewer.id, ownerLabel: viewer.label })
	})

	test("a lookup needs the endpoint's own action on the org, not the directory's: a holder on the company alone is refused by IAM", async () => {
		const s = await stack()
		const worlds = await s.seed()
		const viewer = await s.member(worlds, 'viewer', 'viewer', 'own')
		// deals.write on the org, without the directory's crm.read, looks a member up.
		const writer = await s.inOrg(worlds, 'writer', 'deals.write')
		const answered = await s.call(writer.key, 'candidate', { id: worlds.own.key, principalId: viewer.id })
		expect(answered.status).toBe(200)
		expect(Found.parse(Result.parse(answered.body).result).member).toEqual({ principalId: viewer.id, label: viewer.label })
		// IAM holds no containment below the org, so a grant on the deal's company does not authorize a lookup there.
		const company = await s.inCompany(worlds, 'company-writer', 'deals.write')
		const refused = await s.call(company.key, 'candidate', { id: worlds.own.key, principalId: viewer.id })
		expect(refused.status).toBe(403)
		expect(JSON.stringify(refused.body)).toContain('IAM checked its live permissions')
	})

	test("listing the org's members from a deal needs the org's members.list action on the org: a holder on the company alone is refused by IAM", async () => {
		const s = await stack()
		const worlds = await s.seed()
		const manager = await s.member(worlds, 'manager', 'manager', 'own')
		const viewer = await s.member(worlds, 'viewer', 'viewer', 'own')
		await s.member(worlds, 'elsewhere', 'viewer', 'other')
		const listed = await s.call(viewer.key, 'team', { id: worlds.own.key })
		expect(listed.status).toBe(200)
		expect(Team.parse(Result.parse(listed.body).result).members.map((member) => member.principalId).sort()).toEqual([manager.id, viewer.id].sort())
		const reader = await s.inCompany(worlds, 'reader', 'crm.read')
		const refused = await s.call(reader.key, 'team', { id: worlds.own.key })
		expect(refused.status).toBe(403)
		expect(JSON.stringify(refused.body)).toContain('IAM checked its live permissions')
	})

	test('a caller of another org is refused by the access form before IAM is asked', async () => {
		const s = await stack()
		const worlds = await s.seed()
		const viewer = await s.member(worlds, 'viewer', 'viewer', 'own')
		const outsider = await s.member(worlds, 'outsider', 'manager', 'other')
		expect((await s.call(outsider.key, 'candidate', { id: worlds.own.key, principalId: viewer.id })).status).toBe(404)
	})
})
