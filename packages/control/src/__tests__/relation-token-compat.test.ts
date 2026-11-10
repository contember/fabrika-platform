// A token that carries relation entries (`{ scope: { type: '~rel', value } }`, and `~relin` with
// `<relation>:<dimension>:<node>` for a scoped grant), read by every framework release of the window: the claim parser
// keeps the token, the proxy's requirement check admits an action held only through a relation (the framework decides
// where), and no older release reads either entry as a value of any dimension or as a global grant. An older
// application never declares a relation, so IAM never signs one for it; this is the margin.

import * as current from '@fabrika/auth-core'
import * as core04 from '@fabrika/auth-core-0.4'
import * as core05 from '@fabrika/auth-core-0.5'
import * as core06 from '@fabrika/auth-core-0.6'
import * as core07 from '@fabrika/auth-core-0.7'
import * as core08 from '@fabrika/auth-core-0.8'
import { describe, expect, test } from 'bun:test'

const relation = { type: current.RELATION_SCOPE_TYPE, value: 'member' }
const inside = current.relationInsideScope({ relation: 'member', dimension: 'project', node: 'p1' })
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
		{ action: 'projects.list', scope: { type: 'project', value: 'p1' }, source: 'grant' },
		{ action: 'projects.read', scope: relation, source: 'grant' },
		{ action: 'projects.write', scope: inside, source: 'grant' },
	],
})
const payload: unknown = JSON.parse(JSON.stringify(claims))

/** What one release reads of the token: the entries it keeps, the proxy's requirement check and the framework's scope reads. */
interface Facts {
	readonly entries: number
	readonly on: boolean
	readonly over: boolean
	readonly app: boolean
	readonly global: boolean
	readonly atValue: boolean
	readonly atRelationName: boolean
	readonly readValues: readonly string[] | null
	readonly listValues: readonly string[] | null
	/** An action held only inside a node: the proxy admits it, and no release reads a value or a global grant from it. */
	readonly insideOn: boolean
	readonly insideGlobal: boolean
	readonly insideAtNode: boolean
	readonly insideValues: readonly string[] | null
}

const ON = { kind: 'action', action: 'projects.read', access: { form: 'on', dimension: 'project', from: 'id' } } as const
const OVER = { kind: 'action', action: 'projects.read', access: { form: 'over', dimension: 'project' } } as const
const APP = { kind: 'action', action: 'projects.read', access: { form: 'app' } } as const
const WRITE_ON = { kind: 'action', action: 'projects.write', access: { form: 'on', dimension: 'project', from: 'id' } } as const
const P1 = { type: 'project', value: 'p1' }
const NAMED = { type: 'project', value: 'member' }

function factsOf<P>(
	perms: P[],
	satisfies: (requirement: typeof ON | typeof OVER | typeof APP | typeof WRITE_ON, perms: readonly P[]) => boolean,
	permits: (perms: P[], action: string, scope?: { type: string; value: string }) => boolean,
	scopedValues: (perms: P[], action: string, dimension: string) => string[] | null,
): Facts {
	return {
		entries: perms.length,
		on: satisfies(ON, perms),
		over: satisfies(OVER, perms),
		app: satisfies(APP, perms),
		global: permits(perms, 'projects.read'),
		atValue: permits(perms, 'projects.read', P1),
		atRelationName: permits(perms, 'projects.read', NAMED),
		readValues: scopedValues(perms, 'projects.read', 'project'),
		listValues: scopedValues(perms, 'projects.list', 'project'),
		insideOn: satisfies(WRITE_ON, perms),
		insideGlobal: permits(perms, 'projects.write'),
		insideAtNode: permits(perms, 'projects.write', P1),
		insideValues: scopedValues(perms, 'projects.write', 'project'),
	}
}

const releases: readonly (readonly [string, () => Facts])[] = [
	['0.4.8', () => factsOf(core04.parseAccessClaims(payload)?.perms ?? [], core04.satisfies, core04.permits, core04.scopedValues)],
	['0.5.5', () => factsOf(core05.parseAccessClaims(payload)?.perms ?? [], core05.satisfies, core05.permits, core05.scopedValues)],
	['0.6.0', () => factsOf(core06.parseAccessClaims(payload)?.perms ?? [], core06.satisfies, core06.permits, core06.scopedValues)],
	['0.7.0', () => factsOf(core07.parseAccessClaims(payload)?.perms ?? [], core07.satisfies, core07.permits, core07.scopedValues)],
	['0.8.2', () => factsOf(core08.parseAccessClaims(payload)?.perms ?? [], core08.satisfies, core08.permits, core08.scopedValues)],
	['current', () => factsOf(current.parseAccessClaims(payload)?.perms ?? [], current.satisfies, current.permits, current.scopedValues)],
]

describe('every release of the window reading a token with relation entries', () => {
	test.each(releases)('auth-core %s keeps the token, admits the action at the proxy and reads no value or global grant from it', (_, read) => {
		expect(read()).toEqual({
			entries: 3,
			on: true,
			over: true,
			app: false,
			global: false,
			atValue: false,
			atRelationName: false,
			readValues: [],
			listValues: ['p1'],
			insideOn: true,
			insideGlobal: false,
			insideAtNode: false,
			insideValues: [],
		})
	})
})
