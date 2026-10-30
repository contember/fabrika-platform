import { describe, expect, test } from 'bun:test'
import { normalizeEmailIdentity } from '../membership'
import { accessClaimsToResolved, type AccessTokenClaims, buildAccessClaims, parseAccessClaims, principalKind } from '../token'
import type { PermissionEntry } from '../types'

const ISS = 'https://iam.example.com'

const perms: PermissionEntry[] = [
	{ action: '*', scope: null, source: 'bootstrap' },
	{ action: 'project.read', scope: { type: 'project', value: 'demo' }, source: 'grant' },
	{ action: 'report.*', scope: null, source: 'group:acme/core' },
]

function principalClaims(overrides: Partial<AccessTokenClaims> = {}): AccessTokenClaims {
	return {
		...buildAccessClaims({
			iss: ISS,
			app: 'example-app',
			subject: 'user-1',
			type: 'user',
			label: 'a@b.cz',
			permissions: perms,
			issuedAt: 1000,
			expiresAt: 1300,
		}),
		...overrides,
	}
}

describe('buildAccessClaims', () => {
	test('maps app→aud, subject→sub, type→ptype and carries the resolved permissions — no `kind`', () => {
		const claims = principalClaims()
		expect('kind' in claims).toBe(false)
		expect(claims.aud).toBe('example-app')
		expect(claims.sub).toBe('user-1')
		expect(claims.iss).toBe(ISS)
		expect(claims.iat).toBe(1000)
		expect(claims.exp).toBe(1300)
		expect(claims.ptype).toBe('user')
		expect(claims.perms).toEqual(perms)
	})

	test('an anonymous token omits ptype and may carry a null label', () => {
		const claims = buildAccessClaims({
			iss: ISS,
			app: 'a',
			subject: 'cred-1',
			label: null,
			permissions: [{ action: 'report.read', scope: { type: 'report', value: 'q2' }, source: 'grant' }],
			issuedAt: 1,
			expiresAt: 2,
		})
		expect(claims.ptype).toBeUndefined()
		expect(claims.label).toBeNull()
	})
})

describe('parseAccessClaims — principal round-trip', () => {
	test('a built principal token parses back to identical claims', () => {
		const built = principalClaims()
		// Serialize → parse, exactly the JSON round-trip a JWT payload goes through.
		const onWire: unknown = JSON.parse(JSON.stringify(built))
		expect(parseAccessClaims(onWire)).toEqual(built)
	})

	test('parsed claims map into a ResolvedPrincipal the AuthContext consumes', () => {
		const parsed = parseAccessClaims(JSON.parse(JSON.stringify(principalClaims())))
		expect(parsed?.ptype).toBe('user')
		expect(parsed && accessClaimsToResolved(parsed, 'req-9')).toEqual({
			id: 'user-1',
			type: 'user',
			label: 'a@b.cz',
			permissions: perms,
			requestId: 'req-9',
		})
	})
})

describe('parseAccessClaims — anonymous round-trip', () => {
	test('an anonymous (no-ptype) token round-trips, and resolves to no principal', () => {
		const built = buildAccessClaims({
			iss: ISS,
			app: 'example-app',
			subject: 'cred-1',
			label: 'Client ACME — report Q2',
			permissions: [{ action: 'report.read', scope: { type: 'report', value: 'q2' }, source: 'grant' }],
			issuedAt: 1000,
			expiresAt: 1300,
		})
		const parsed = parseAccessClaims(JSON.parse(JSON.stringify(built)))
		expect(parsed).toEqual(built)
		expect(parsed && accessClaimsToResolved(parsed, 'req-1')).toBeNull()
	})

	test('a null label survives the round-trip', () => {
		const built = buildAccessClaims({
			iss: ISS,
			app: 'a',
			subject: 'cred-2',
			label: null,
			permissions: [{ action: 'x', scope: null, source: 'grant' }],
			issuedAt: 1,
			expiresAt: 2,
		})
		expect(parseAccessClaims(JSON.parse(JSON.stringify(built)))?.label).toBeNull()
	})
})

describe('parseAccessClaims — rejects malformed', () => {
	test('missing standard claim (aud)', () => {
		const { aud: _aud, ...rest } = principalClaims()
		expect(parseAccessClaims(rest)).toBeNull()
	})

	test('non-numeric exp', () => {
		expect(parseAccessClaims({ ...principalClaims(), exp: 'soon' })).toBeNull()
	})

	test('bad principal type', () => {
		expect(parseAccessClaims({ ...principalClaims(), ptype: 'robot' })).toBeNull()
	})

	test('missing perms', () => {
		const { perms: _perms, ...rest } = principalClaims()
		expect(parseAccessClaims(rest)).toBeNull()
	})

	test('malformed permission entry (missing action)', () => {
		expect(parseAccessClaims({ ...principalClaims(), perms: [{ scope: null, source: 'grant' }] })).toBeNull()
	})

	test('malformed permission source', () => {
		expect(parseAccessClaims({ ...principalClaims(), perms: [{ action: 'x', scope: null, source: 'nope' }] })).toBeNull()
	})

	test('malformed scope (value not a string)', () => {
		expect(
			parseAccessClaims({
				...principalClaims(),
				perms: [{ action: 'x', scope: { type: 'project', value: 5 }, source: 'grant' }],
			}),
		).toBeNull()
	})

	test('a non-string label', () => {
		expect(parseAccessClaims({ ...principalClaims(), label: 7 })).toBeNull()
	})

	test('non-object payload', () => {
		expect(parseAccessClaims(null)).toBeNull()
		expect(parseAccessClaims('a string')).toBeNull()
	})
})

describe('share-link claims', () => {
	const linkParams = {
		iss: ISS,
		app: 'notes@prod',
		subject: 'cred-link',
		label: 'Shared note',
		permissions: [{ action: 'notes.read', scope: { type: 'note', value: 'n1' }, source: 'grant' as const }],
		issuedAt: 1,
		expiresAt: 2,
		link: { mount: 'shared', chain: [{ type: 'note', value: 'n1' }, { type: 'workspace', value: 'w1' }] },
	}

	test('a link token round-trips its mount and chain and has the link principal kind', () => {
		const parsed = parseAccessClaims(JSON.parse(JSON.stringify(buildAccessClaims(linkParams))))
		expect(parsed?.link).toEqual(linkParams.link)
		expect(parsed?.ptype).toBeUndefined()
		expect(parsed === null ? null : principalKind(parsed)).toBe('link')
	})

	test('the principal kind of a bound token is its ptype, and of a plain anonymous token null', () => {
		expect(principalKind(principalClaims())).toBe('user')
		expect(principalKind(buildAccessClaims({ ...linkParams, link: undefined }))).toBeNull()
	})

	test('a link token cannot also name a principal type', () => {
		expect(() => buildAccessClaims({ ...linkParams, type: 'user' })).toThrow()
		expect(parseAccessClaims({ ...buildAccessClaims(linkParams), ptype: 'user' })).toBeNull()
	})

	test('a malformed link claim rejects the whole token', () => {
		const base = buildAccessClaims(linkParams)
		for (
			const link of [null, 'shared', { mount: '', chain: [{ type: 'note', value: 'n1' }] }, { mount: 'shared', chain: [] }, {
				mount: 'shared',
				chain: [null],
			}, { mount: 'shared', chain: [{ type: 'note' }] }]
		) {
			expect(parseAccessClaims({ ...base, link })).toBeNull()
		}
	})
})

describe('workload claims', () => {
	const workloadParams = {
		iss: ISS,
		app: 'notes@prod',
		subject: 'principal-job',
		label: 'job:nightly',
		permissions: [{ action: 'notes.purge', scope: null, source: 'grant' as const }],
		issuedAt: 1,
		expiresAt: 2,
	}

	test.each(['job', 'webhook', 'app'] as const)('a %s token round-trips its kind and its workload', (type) => {
		const built = buildAccessClaims({ ...workloadParams, type, workload: type === 'app' ? 'shop' : 'nightly' })
		const parsed = parseAccessClaims(JSON.parse(JSON.stringify(built)))
		expect(parsed).toEqual(built)
		expect(parsed === null ? null : principalKind(parsed)).toBe(type)
		expect(parsed === null ? 'unparsed' : accessClaimsToResolved(parsed, 'req-1')).toBeNull()
	})

	test('a workload kind names its workload, and no other kind does', () => {
		expect(() => buildAccessClaims({ ...workloadParams, type: 'job' })).toThrow()
		expect(() => buildAccessClaims({ ...workloadParams, type: 'service', workload: 'nightly' })).toThrow()
		expect(() => buildAccessClaims({ ...workloadParams, type: 'job', workload: 'a b' })).toThrow()
		const job = buildAccessClaims({ ...workloadParams, type: 'job', workload: 'nightly' })
		expect(parseAccessClaims({ ...job, workload: undefined })).toBeNull()
		expect(parseAccessClaims({ ...job, workload: '' })).toBeNull()
		expect(parseAccessClaims({ ...job, workload: 7 })).toBeNull()
		expect(parseAccessClaims({ ...principalClaims(), workload: 'nightly' })).toBeNull()
	})

	test("a public procedure's token names its full endpoint id, and only an endpoint id", () => {
		const built = buildAccessClaims({ ...workloadParams, type: 'public', workload: 'api.stats.cta' })
		const parsed = parseAccessClaims(JSON.parse(JSON.stringify(built)))
		expect(parsed).toEqual(built)
		expect(parsed === null ? null : principalKind(parsed)).toBe('public')
		expect(parsed === null ? 'unparsed' : accessClaimsToResolved(parsed, 'req-1')).toBeNull()
		for (const workload of ['nightly', 'api..cta', 'api.stats.', '.api.stats', 'api.stats-cta', `api.${'a'.repeat(130)}`]) {
			expect(() => buildAccessClaims({ ...workloadParams, type: 'public', workload })).toThrow()
			expect(parseAccessClaims({ ...built, workload })).toBeNull()
		}
	})

	test('a job, webhook or connector token keeps the names it had, a dotted one refused', () => {
		const job = buildAccessClaims({ ...workloadParams, type: 'job', workload: 'nightly_digest-2' })
		expect(parseAccessClaims(job)).toEqual(job)
		expect(parseAccessClaims({ ...job, workload: 'api.stats.cta' })).toBeNull()
	})

	test('an unknown principal kind rejects the whole token', () => {
		for (const ptype of ['robot', 'App', 'link', 'machine', 'Public']) {
			expect(parseAccessClaims({ ...principalClaims(), ptype })).toBeNull()
		}
	})
})

describe('the mailbox of a user token', () => {
	const userParams = {
		iss: ISS,
		app: 'notes@prod',
		subject: 'user-1',
		type: 'user' as const,
		label: 'Ann@Example.com',
		permissions: perms,
		issuedAt: 1,
		expiresAt: 2,
	}

	test("a user token carries the principal's mailbox beside its spelling, and it round-trips", () => {
		const built = buildAccessClaims({ ...userParams, email: 'ann@example.com' })
		const parsed = parseAccessClaims(JSON.parse(JSON.stringify(built)))
		expect(parsed?.email).toBe('ann@example.com')
		expect(parsed?.label).toBe('Ann@Example.com')
		expect(parseAccessClaims(JSON.parse(JSON.stringify(buildAccessClaims(userParams))))?.email).toBeUndefined()
	})

	test('only a user token carries one', () => {
		expect(() => buildAccessClaims({ ...userParams, type: 'service', email: 'ann@example.com' })).toThrow()
		expect(() => buildAccessClaims({ ...userParams, type: undefined, email: 'ann@example.com' })).toThrow()
		const service = buildAccessClaims({ ...userParams, type: 'service' })
		expect(parseAccessClaims({ ...service, email: 'ann@example.com' })).toBeNull()
		const anonymous = buildAccessClaims({ ...userParams, type: undefined })
		expect(parseAccessClaims({ ...anonymous, email: 'ann@example.com' })).toBeNull()
		const job = buildAccessClaims({ ...userParams, type: 'job', workload: 'digest' })
		expect(parseAccessClaims({ ...job, email: 'ann@example.com' })).toBeNull()
	})

	test('a mailbox IAM stored round-trips, also one its normalization would change on a second pass', () => {
		const stored = normalizeEmailIdentity('J\u030C@example.test')
		expect(normalizeEmailIdentity(stored)).not.toBe(stored)
		const built = buildAccessClaims({ ...userParams, email: stored })
		expect(parseAccessClaims(JSON.parse(JSON.stringify(built)))?.email).toBe(stored)
	})

	test('a mailbox that is not normalized, not a string or no address rejects the whole token', () => {
		for (const email of ['Ann@Example.com', ' ann@example.com', '', 'ann', 7, null]) {
			expect(parseAccessClaims({ ...buildAccessClaims(userParams), email })).toBeNull()
		}
		expect(() => buildAccessClaims({ ...userParams, email: 'Ann@Example.com' })).toThrow()
	})
})

describe('the session mark of a principal token', () => {
	const sessionParams = {
		iss: ISS,
		app: 'console',
		subject: 'user-1',
		type: 'user' as const,
		label: 'ann@example.com',
		permissions: perms,
		issuedAt: 1,
		expiresAt: 2,
	}

	test("a session's token round-trips the mark, and a token without one parses without it", () => {
		const built = buildAccessClaims({ ...sessionParams, session: true })
		expect(parseAccessClaims(JSON.parse(JSON.stringify(built)))?.session).toBe(true)
		expect(parseAccessClaims(JSON.parse(JSON.stringify(buildAccessClaims(sessionParams))))?.session).toBeUndefined()
	})

	test('only a person or a service is signed in, and the mark is only true', () => {
		expect(() => buildAccessClaims({ ...sessionParams, type: undefined, session: true })).toThrow()
		expect(() => buildAccessClaims({ ...sessionParams, type: 'job', workload: 'digest', session: true })).toThrow()
		const job = buildAccessClaims({ ...sessionParams, type: 'job', workload: 'digest' })
		expect(parseAccessClaims({ ...job, session: true })).toBeNull()
		const anonymous = buildAccessClaims({ ...sessionParams, type: undefined })
		expect(parseAccessClaims({ ...anonymous, session: true })).toBeNull()
		for (const session of [false, 'true', 1, null]) {
			expect(parseAccessClaims({ ...buildAccessClaims(sessionParams), session })).toBeNull()
		}
	})
})

describe('the terminal of a person signed in on one (ADR-0067)', () => {
	const terminalParams = {
		iss: ISS,
		app: 'attendance@prod',
		subject: 'user-1',
		type: 'user' as const,
		label: 'ann@example.com',
		session: true as const,
		permissions: [{ action: 'attendance.record', scope: null, source: 'terminal' as const }],
		issuedAt: 1,
		expiresAt: 2,
	}
	const terminal = { id: 'terminal-1', label: 'Entrance' }

	test('a terminal session token carries amr and the terminal, and round-trips them with the terminal source', () => {
		const built = buildAccessClaims({ ...terminalParams, terminal })
		expect(built.amr).toBe('terminal_assertion')
		expect(built.terminal).toEqual(terminal)
		const parsed = parseAccessClaims(JSON.parse(JSON.stringify(built)))
		expect(parsed?.amr).toBe('terminal_assertion')
		expect(parsed?.terminal).toEqual(terminal)
		expect(parsed?.perms).toEqual(terminalParams.permissions)
	})

	test('a token without them parses without them', () => {
		const parsed = parseAccessClaims(JSON.parse(JSON.stringify(buildAccessClaims(terminalParams))))
		expect(parsed).not.toBeNull()
		expect(parsed?.amr).toBeUndefined()
		expect(parsed?.terminal).toBeUndefined()
	})

	test("only a person's session token names a terminal", () => {
		expect(() => buildAccessClaims({ ...terminalParams, type: 'service', terminal })).toThrow()
		expect(() => buildAccessClaims({ ...terminalParams, session: undefined, terminal })).toThrow()
		expect(() => buildAccessClaims({ ...terminalParams, terminal: { id: '', label: 'Entrance' } })).toThrow()
		const claims = { amr: 'terminal_assertion', terminal }
		expect(parseAccessClaims({ ...buildAccessClaims({ ...terminalParams, type: 'service' }), ...claims })).toBeNull()
		expect(parseAccessClaims({ ...buildAccessClaims({ ...terminalParams, session: undefined }), ...claims })).toBeNull()
	})

	test('amr and the terminal come together and well-formed, or the whole token is refused', () => {
		const plain = buildAccessClaims(terminalParams)
		expect(parseAccessClaims({ ...plain, amr: 'terminal_assertion' })).toBeNull()
		expect(parseAccessClaims({ ...plain, terminal })).toBeNull()
		expect(parseAccessClaims({ ...plain, amr: 'pwd', terminal })).toBeNull()
		for (const value of [{ id: 'terminal-1' }, { id: 7, label: 'Entrance' }, { id: 'terminal-1', label: '' }, 'terminal-1', null]) {
			expect(parseAccessClaims({ ...plain, amr: 'terminal_assertion', terminal: value })).toBeNull()
		}
	})
})
