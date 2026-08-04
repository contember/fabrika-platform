import { describe, expect, test } from 'bun:test'
import { createHarness, type Harness, seedInlineGrant, seedService, seedUser } from './helpers/harness'

// listPrincipals (the app's people directory): the DB layer's app-scoped, user-only,
// deduped enumeration (`getPrincipalsForApp`) — an operator only ever sees the roster of
// the app it is scoped to. Plus `Db.listPrincipals`, the admin directory + its `q` search.

describe('Db.getPrincipalsForApp', () => {
	test('returns app + cross-app users, excludes other apps and services, dedups, flags disabled', () => {
		const h = createHarness()

		const inPoplach = seedUser(h.sqlite, { sub: 'a', email: 'a@poplach.test' })
		seedInlineGrant(h.sqlite, inPoplach, ['project.read'], null, 'poplach')

		const crossApp = seedUser(h.sqlite, { sub: 'b', email: 'b@poplach.test' })
		seedInlineGrant(h.sqlite, crossApp, ['*'], null, null) // app NULL = all apps

		const inOpice = seedUser(h.sqlite, { sub: 'c', email: 'c@opice.test' })
		seedInlineGrant(h.sqlite, inOpice, ['project.read'], null, 'opice')

		const disabled = seedUser(h.sqlite, { sub: 'd', email: 'd@poplach.test', disabled: true })
		seedInlineGrant(h.sqlite, disabled, ['project.read'], null, 'poplach')

		const multiGrant = seedUser(h.sqlite, { sub: 'e', email: 'e@poplach.test' })
		seedInlineGrant(h.sqlite, multiGrant, ['project.read'], null, 'poplach')
		seedInlineGrant(h.sqlite, multiGrant, ['member.manage'], null, 'poplach')

		const service = seedService(h.sqlite, { commonName: 'ci-bot' })
		seedInlineGrant(h.sqlite, service, ['report.write'], null, 'poplach')

		return h.repositories.principals.getPrincipalsForApp('poplach').then((rows) => {
			const ids = rows.map((r) => r.id)
			expect(new Set(ids)).toEqual(new Set([inPoplach, crossApp, disabled, multiGrant]))
			expect(ids).not.toContain(inOpice) // other app's user excluded
			expect(ids).not.toContain(service) // services are not people
			expect(ids.filter((id) => id === multiGrant)).toHaveLength(1) // deduped across grants
			expect(rows.find((r) => r.id === disabled)?.disabled_at).not.toBeNull()
		})
	})

	test('an app with only the cross-app user still returns it; an unknown app returns just cross-app', async () => {
		const h = createHarness()
		const crossApp = seedUser(h.sqlite, { sub: 'b', email: 'b@x.test' })
		seedInlineGrant(h.sqlite, crossApp, ['*'], null, null)
		const opiceOnly = seedUser(h.sqlite, { sub: 'c', email: 'c@opice.test' })
		seedInlineGrant(h.sqlite, opiceOnly, ['project.read'], null, 'opice')

		expect((await h.repositories.principals.getPrincipalsForApp('whatever')).map((r) => r.id)).toEqual([crossApp])
	})

	test('expired grants do not make a user a member', async () => {
		const h = createHarness()
		const expired = seedUser(h.sqlite, { sub: 'x', email: 'x@poplach.test' })
		// expires_at in the past → not an active member.
		h.sqlite.run(
			'INSERT INTO grants (id, principal_id, permissions, app, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
			['g-exp', expired, JSON.stringify(['project.read']), 'poplach', 1, Math.floor(Date.now() / 1000)],
		)
		expect(await h.repositories.principals.getPrincipalsForApp('poplach')).toEqual([])
	})

	test('the roster is app-scoped — a poplach read never includes an opice-only user', async () => {
		const h = createHarness()
		const inPoplach = seedUser(h.sqlite, { sub: 'op-sub', email: 'op@poplach.test' })
		seedInlineGrant(h.sqlite, inPoplach, ['project.read'], null, 'poplach')
		const teammate = seedUser(h.sqlite, { sub: 't-sub', email: 'teammate@poplach.test' })
		seedInlineGrant(h.sqlite, teammate, ['project.read'], null, 'poplach')
		const opicePerson = seedUser(h.sqlite, { sub: 'o-sub', email: 'someone@opice.test' })
		seedInlineGrant(h.sqlite, opicePerson, ['project.read'], null, 'opice')

		const emails = (await h.repositories.principals.getPrincipalsForApp('poplach')).map((r) => r.email)
		expect(new Set(emails)).toEqual(new Set(['op@poplach.test', 'teammate@poplach.test']))
		expect(emails).not.toContain('someone@opice.test')
	})
})

/**
 * Force SQLite's `LIKE` to behave the way Postgres's does — case-SENSITIVE.
 *
 * This is the whole point of the test below. SQLite case-folds ASCII in `LIKE` and Postgres does
 * not, so a query written as `label LIKE ?` passes here and then silently stops matching 'Alice'
 * for 'alice' once the same SQL runs on Postgres. With the pragma on, that divergence becomes a
 * failing test instead of a production surprise: only the portable form (`LOWER()` on both sides)
 * survives. Reverting `listPrincipals` to a bare `LIKE` makes every assertion in the block fail.
 */
function withPostgresLikeSemantics(h: Harness): void {
	h.sqlite.exec('PRAGMA case_sensitive_like = ON')
}

describe('Db.listPrincipals — q search', () => {
	test('matches label and email case-INSENSITIVELY, under case-sensitive LIKE semantics', async () => {
		const h = createHarness()
		withPostgresLikeSemantics(h)
		const alice = seedUser(h.sqlite, { sub: 'a', email: 'Alice@Firma.cz', label: 'Alice Nováková' })
		const bob = seedUser(h.sqlite, { sub: 'b', email: 'bob@firma.cz', label: 'Bob Dvořák' })

		// Lowercase needle vs. capitalised label.
		expect((await h.repositories.principals.listPrincipals({ limit: 50, q: 'alice' })).map((r) => r.id)).toEqual([alice])
		// Uppercase needle vs. lowercase label.
		expect((await h.repositories.principals.listPrincipals({ limit: 50, q: 'BOB' })).map((r) => r.id)).toEqual([bob])
		// The email column is normalised too, not just the label.
		expect((await h.repositories.principals.listPrincipals({ limit: 50, q: 'alice@firma' })).map((r) => r.id)).toEqual([alice])
		// A needle matching neither still matches nothing.
		expect(await h.repositories.principals.listPrincipals({ limit: 50, q: 'carol' })).toEqual([])
	})

	test('q composes with the type filter, and services (email NULL) are searchable by label', async () => {
		const h = createHarness()
		withPostgresLikeSemantics(h)
		const user = seedUser(h.sqlite, { sub: 'r', email: 'reporter@firma.cz', label: 'Reports Person' })
		const service = seedService(h.sqlite, { commonName: 'ci', label: 'Reports Exporter' })

		expect(new Set((await h.repositories.principals.listPrincipals({ limit: 50, q: 'reports' })).map((r) => r.id))).toEqual(new Set([user, service]))
		expect((await h.repositories.principals.listPrincipals({ limit: 50, type: 'service', q: 'REPORTS' })).map((r) => r.id)).toEqual([service])
	})
})

describe('Db.listPrincipals — ordering', () => {
	test('rows sharing a created_at second are ordered deterministically by id', async () => {
		// created_at is whole seconds, so same-second rows have no order of their own; without the
		// `id DESC` tiebreak the engine picks one arbitrarily (and SQLite and Postgres pick
		// differently). Ids here are 'user-N' with N increasing, so newest-first means id DESC.
		const h = createHarness()
		const at = 1_782_896_400
		const first = seedUser(h.sqlite, { sub: 'o1', email: 'o1@firma.cz', createdAt: at })
		const second = seedUser(h.sqlite, { sub: 'o2', email: 'o2@firma.cz', createdAt: at })
		const third = seedUser(h.sqlite, { sub: 'o3', email: 'o3@firma.cz', createdAt: at })

		const seeded = new Set([first, second, third])
		const expected = [first, second, third].sort((a, b) => (a < b ? 1 : -1))
		// Filtered because migration 0008 seeds `provisioning-admin`, which is older than these.
		expect((await h.repositories.principals.listPrincipals({ limit: 50 })).map((r) => r.id).filter((id) => seeded.has(id))).toEqual(expected)
	})
})
