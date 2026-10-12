// Script and frame origins and a form's admission in the conservative access diff (ADR-0050 §3): a new origin in
// either directive widens and a removed one narrows, like the three directives before them; a stored snapshot from
// before they existed still compares; any change to a form's admission is shown and widens.

import type { TablePolicyArtifact } from '@fabrika/auth-core'
import { readContractSource } from '@fabrika/check/contract'
import { cspOrigins, headerPolicy } from '@fabrika/proxy-core/headers'
import { describe, expect, test } from 'bun:test'
import { classifyAccess } from '../approval/diff'
import { type AccessSnapshot, parseSnapshot } from '../approval/snapshot'
import { BASE, edited } from './helpers/contracts'

const INBOX: TablePolicyArtifact = {
	scope: { mode: 'inbox', form: 'apply' },
	actions: { read: 'intake.read', insert: null, update: null, delete: null },
	insert: [],
	update: [],
	version: null,
	createdBy: null,
	columns: {},
}

function snapshot(contract = BASE, tables: Readonly<Record<string, TablePolicyArtifact>> = {}): AccessSnapshot {
	return { version: 1, contract: readContractSource(new Map([['fabrika.contract.ts', contract]]), tables), migrations: [], checker: '0.0.0' }
}

const HEALTH = "health: c.health('/healthz'),"
const WIDGET = "{ origin: 'https://widgets.example.com', purpose: 'the booking widget' }"
const withCsp = (csp: string): string => edited(HEALTH, `${HEALTH}\n\tcsp: ${csp},`)

/** `BASE` with an inbox's own action and role, which no membership role grants, and a form that appends to it. */
const FORM = (options: string): string => {
	const vocabulary = edited("'notes.delete': 'Delete notes' },", "'notes.delete': 'Delete notes', 'intake.read': 'Read registrations' },")
	const roles = edited('roles: {', "roles: {\n\t\thr: { grants: ['intake.read'] },", vocabulary)
	return edited(
		HEALTH,
		`${HEALTH}\n\tapply: c.form('/apply', { input: z.strictObject({ name: z.string(), website: z.optional(z.string()), challengeToken: z.string() }), appendTo: 'applications'${options} }),`,
		roles,
	)
}

describe('script and frame origins in the approval diff', () => {
	test('a new script origin and a new frame origin each widen', () => {
		const classification = classifyAccess(snapshot(), snapshot(withCsp(`{ scriptSrc: [${WIDGET}], frameSrc: [${WIDGET}] }`)))
		expect(classification.outcome).toBe('widening')
		expect(classification.changes).toEqual([
			{ widens: true, line: 'CSP `scriptSrc` allows `https://widgets.example.com`' },
			{ widens: true, line: 'CSP `frameSrc` allows `https://widgets.example.com`' },
		])
	})

	test('a removed one narrows', () => {
		const classification = classifyAccess(snapshot(withCsp(`{ scriptSrc: [${WIDGET}], frameSrc: [${WIDGET}] }`)), snapshot())
		expect(classification.outcome).toBe('removal')
		expect(classification.changes).toEqual([
			{ widens: false, line: 'CSP `scriptSrc` no longer allows `https://widgets.example.com`' },
			{ widens: false, line: 'CSP `frameSrc` no longer allows `https://widgets.example.com`' },
		])
	})

	test("removing the last frame origin narrows: frames fall back to default-src 'self', which frame-src 'self' already allowed", () => {
		const before = snapshot(withCsp(`{ frameSrc: [${WIDGET}] }`))
		const after = snapshot()
		const classification = classifyAccess(before, after)
		expect(classification).toEqual({
			outcome: 'removal',
			changes: [{ widens: false, line: 'CSP `frameSrc` no longer allows `https://widgets.example.com`' }],
		})
		const frames = (contract: AccessSnapshot['contract']) => {
			const policy = contract === null
				? ''
				: (headerPolicy(cspOrigins(contract.csp), null).find(([name]) => name === 'Content-Security-Policy')?.[1] ?? '')
			return policy.split('; ').find((directive) => directive.startsWith('frame-src')) ?? "frame-src (default-src) 'self'"
		}
		expect(frames(before.contract)).toBe("frame-src 'self' https://widgets.example.com")
		expect(frames(after.contract)).toBe("frame-src (default-src) 'self'")
	})

	test('a snapshot stored before the two directives existed parses and compares as naming none', () => {
		const stored = snapshot()
		const contract = stored.contract
		if (contract === null) throw new Error('the base has a contract')
		const older = parseSnapshot(JSON.stringify({ ...stored, contract: { ...contract, csp: { connectSrc: [], imgSrc: [], frameAncestors: [] } } }))
		expect(classifyAccess(older, stored).outcome).toBe('unchanged')
		expect(classifyAccess(older, snapshot(withCsp(`{ frameSrc: [${WIDGET}] }`))).changes).toEqual([
			{ widens: true, line: 'CSP `frameSrc` allows `https://widgets.example.com`' },
		])
	})
})

describe("a form's admission in the approval diff", () => {
	const tables = { applications: INBOX }

	test("a challenge shows its provider's origins as widenings and its form as changed", () => {
		const challenged = snapshot(FORM(", honeypot: 'website', challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET' }"), tables)
		const classification = classifyAccess(snapshot(FORM(''), tables), challenged)
		expect(classification.outcome).toBe('widening')
		expect(classification.changes).toContainEqual({ widens: true, line: 'CSP `scriptSrc` allows `https://challenges.cloudflare.com`' })
		expect(classification.changes).toContainEqual({ widens: true, line: 'CSP `frameSrc` allows `https://challenges.cloudflare.com`' })
		expect(classification.changes.some((change) => change.line.startsWith('Mount `apply` changes from'))).toBe(true)
	})

	test('a new rate is shown', () => {
		const classification = classifyAccess(snapshot(FORM(''), tables), snapshot(FORM(', rate: { perClient: 60 }'), tables))
		expect(classification.changes).toEqual([
			{
				widens: true,
				line:
					'Mount `apply` changes from `{"appendTo":"applications","kind":"form","path":"/apply"}` to `{"appendTo":"applications","kind":"form","path":"/apply","rate":{"perClient":60}}`',
			},
		])
	})
})
