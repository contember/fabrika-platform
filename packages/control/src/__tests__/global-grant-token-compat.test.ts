// A token in the compact layout (global grants as names in `gperms`), read by every framework release of the window. A
// release older than `gperms` keeps the token and reads none of its global grants, so it denies more and never allows
// more; IAM signs the layout only where the entries layout is above the bound, which such a reader refused before.

import * as current from '@fabrika/auth-core'
import * as core04 from '@fabrika/auth-core-0.4'
import * as core05 from '@fabrika/auth-core-0.5'
import * as core06 from '@fabrika/auth-core-0.6'
import * as core07 from '@fabrika/auth-core-0.7'
import * as core08 from '@fabrika/auth-core-0.8'
import { describe, expect, test } from 'bun:test'

const claims = current.buildAccessClaims({
	iss: 'https://iam.example.test',
	app: 'projects@prod',
	subject: 'user-1',
	issuedAt: 1_800_000_000,
	expiresAt: 1_800_000_300,
	type: 'user',
	label: 'user-1@example.test',
	email: 'user-1@example.test',
	permissions: [
		{ action: 'projects.read', scope: null, source: 'grant' },
		{ action: 'projects.write', scope: null, source: 'grant' },
		{ action: 'projects.list', scope: { type: 'project', value: 'p1' }, source: 'grant' },
	],
})
const compact: unknown = JSON.parse(JSON.stringify(current.accessTokenPayload(claims, 'compact')))

/** What one release reads of the token: the entries it keeps and the decisions the proxy and the framework take. */
interface Facts {
	readonly entries: number
	readonly app: boolean
	readonly global: boolean
	readonly atValue: boolean
	readonly listAtValue: boolean
}

const APP = { kind: 'action', action: 'projects.read', access: { form: 'app' } } as const
const P1 = { type: 'project', value: 'p1' }

function factsOf<P>(
	perms: P[],
	satisfies: (requirement: typeof APP, perms: readonly P[]) => boolean,
	permits: (perms: P[], action: string, scope?: { type: string; value: string }) => boolean,
): Facts {
	return {
		entries: perms.length,
		app: satisfies(APP, perms),
		global: permits(perms, 'projects.read'),
		atValue: permits(perms, 'projects.read', P1),
		listAtValue: permits(perms, 'projects.list', P1),
	}
}

const older: readonly (readonly [string, () => Facts | null])[] = [
	['0.4.8', () => {
		const read = core04.parseAccessClaims(compact)
		return read === null ? null : factsOf(read.perms, core04.satisfies, core04.permits)
	}],
	['0.5.5', () => {
		const read = core05.parseAccessClaims(compact)
		return read === null ? null : factsOf(read.perms, core05.satisfies, core05.permits)
	}],
	['0.6.0', () => {
		const read = core06.parseAccessClaims(compact)
		return read === null ? null : factsOf(read.perms, core06.satisfies, core06.permits)
	}],
	['0.7.0', () => {
		const read = core07.parseAccessClaims(compact)
		return read === null ? null : factsOf(read.perms, core07.satisfies, core07.permits)
	}],
	['0.8.2', () => {
		const read = core08.parseAccessClaims(compact)
		return read === null ? null : factsOf(read.perms, core08.satisfies, core08.permits)
	}],
]

describe('every release of the window reading a token in the compact layout', () => {
	test.each(older)('auth-core %s keeps the token and reads only its scoped entries', (_, read) => {
		expect(read()).toEqual({ entries: 1, app: false, global: false, atValue: false, listAtValue: true })
	})

	test('the current release reads every grant from it', () => {
		const read = current.parseAccessClaims(compact)
		expect(read === null ? null : factsOf(read.perms, current.satisfies, current.permits)).toEqual({
			entries: 3,
			app: true,
			global: true,
			atValue: true,
			listAtValue: true,
		})
	})
})
