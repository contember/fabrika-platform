// Script, frame, style and font origins and a form's admission in the conservative access diff (ADR-0050 §3): a new
// origin in any directive widens and a removed one narrows, like the three directives before them; a stored snapshot from
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
			{ effect: 'widens', line: 'CSP `scriptSrc` allows `https://widgets.example.com`' },
			{ effect: 'widens', line: 'CSP `frameSrc` allows `https://widgets.example.com`' },
		])
	})

	test('a removed one narrows', () => {
		const classification = classifyAccess(snapshot(withCsp(`{ scriptSrc: [${WIDGET}], frameSrc: [${WIDGET}] }`)), snapshot())
		expect(classification.outcome).toBe('no-widening')
		expect(classification.changes).toEqual([
			{ effect: 'narrows', line: 'CSP `scriptSrc` no longer allows `https://widgets.example.com`' },
			{ effect: 'narrows', line: 'CSP `frameSrc` no longer allows `https://widgets.example.com`' },
		])
	})

	test("removing the last frame origin narrows: frames fall back to default-src 'self', which frame-src 'self' already allowed", () => {
		const before = snapshot(withCsp(`{ frameSrc: [${WIDGET}] }`))
		const after = snapshot()
		const classification = classifyAccess(before, after)
		expect(classification).toEqual({
			outcome: 'no-widening',
			changes: [{ effect: 'narrows', line: 'CSP `frameSrc` no longer allows `https://widgets.example.com`' }],
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
		expect(classifyAccess(older, stored).outcome).toBe('none')
		expect(classifyAccess(older, snapshot(withCsp(`{ frameSrc: [${WIDGET}] }`))).changes).toEqual([
			{ effect: 'widens', line: 'CSP `frameSrc` allows `https://widgets.example.com`' },
		])
	})
})

describe('style and font origins in the approval diff', () => {
	const FONTS_CSS = "{ origin: 'https://fonts.googleapis.com', purpose: 'the typeface stylesheet' }"
	const FONTS = "{ origin: 'https://fonts.gstatic.com', purpose: 'the typeface files' }"

	test('a new style origin and a new font origin each widen, and the policy carries them', () => {
		const after = snapshot(withCsp(`{ styleSrc: [${FONTS_CSS}], fontSrc: [${FONTS}] }`))
		const classification = classifyAccess(snapshot(), after)
		expect(classification.outcome).toBe('widening')
		expect(classification.changes).toEqual([
			{ effect: 'widens', line: 'CSP `styleSrc` allows `https://fonts.googleapis.com`' },
			{ effect: 'widens', line: 'CSP `fontSrc` allows `https://fonts.gstatic.com`' },
		])
		const contract = after.contract
		if (contract === null) throw new Error('the candidate has a contract')
		const policy = headerPolicy(cspOrigins(contract.csp), null).find(([name]) => name === 'Content-Security-Policy')?.[1]
		expect(policy).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;")
		expect(policy).toContain("font-src 'self' data: https://fonts.gstatic.com;")
	})

	test('a removed one narrows', () => {
		const classification = classifyAccess(snapshot(withCsp(`{ styleSrc: [${FONTS_CSS}], fontSrc: [${FONTS}] }`)), snapshot())
		expect(classification.outcome).toBe('no-widening')
		expect(classification.changes).toEqual([
			{ effect: 'narrows', line: 'CSP `styleSrc` no longer allows `https://fonts.googleapis.com`' },
			{ effect: 'narrows', line: 'CSP `fontSrc` no longer allows `https://fonts.gstatic.com`' },
		])
	})
})

describe('public variables in the approval diff', () => {
	const tables = { applications: INBOX }
	const SPA = "app: c.spa('/', { dir: 'dist/app', access: { member: true } }),"

	test("an SPA mount's public variable is shown by name, and so is a challenge's site key", () => {
		const listed = snapshot(edited(SPA, "app: c.spa('/', { dir: 'dist/app', access: { member: true }, public: ['SIGNUP_URL'] }),"))
		expect(classifyAccess(snapshot(), listed).changes).toEqual([
			{ effect: 'widens', line: 'Mount `app` serves its pages the public variable `SIGNUP_URL`' },
		])
		expect(classifyAccess(listed, snapshot()).changes).toEqual([{
			effect: 'narrows',
			line: 'Mount `app` no longer serves the public variable `SIGNUP_URL`',
		}])
		const challenge = ", honeypot: 'website', challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET' }"
		const withSiteKey = ", honeypot: 'website', challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET', siteKey: 'TURNSTILE_SITE_KEY' }"
		const changes = classifyAccess(snapshot(FORM(challenge), tables), snapshot(FORM(withSiteKey), tables)).changes
		expect(changes).toEqual([{ effect: 'widens', line: 'Form `apply` serves every page its challenge site key from `TURNSTILE_SITE_KEY`' }])
		expect(classifyAccess(snapshot(), snapshot(FORM(withSiteKey), tables)).changes).toContainEqual({
			effect: 'widens',
			line: 'New form mount `apply`, serving the public variable `TURNSTILE_SITE_KEY` to every page',
		})
	})
})

describe("a form's admission in the approval diff", () => {
	const tables = { applications: INBOX }

	test("a challenge shows its provider's origins as widenings and its form as changed", () => {
		const challenged = snapshot(FORM(", honeypot: 'website', challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET' }"), tables)
		const classification = classifyAccess(snapshot(FORM(''), tables), challenged)
		expect(classification.outcome).toBe('widening')
		expect(classification.changes).toContainEqual({ effect: 'widens', line: 'CSP `scriptSrc` allows `https://challenges.cloudflare.com`' })
		expect(classification.changes).toContainEqual({ effect: 'widens', line: 'CSP `frameSrc` allows `https://challenges.cloudflare.com`' })
		expect(classification.changes.some((change) => change.line.startsWith('Mount `apply` changes from'))).toBe(true)
	})

	test('a new rate is shown', () => {
		const classification = classifyAccess(snapshot(FORM(''), tables), snapshot(FORM(', rate: { perClient: 60 }'), tables))
		expect(classification.changes).toEqual([
			{
				effect: 'widens',
				line:
					'Mount `apply` changes from `{"appendTo":"applications","kind":"form","path":"/apply"}` to `{"appendTo":"applications","kind":"form","path":"/apply","rate":{"perClient":60}}`',
			},
		])
	})
})

describe("a form's files in the approval diff", () => {
	const NOTES: TablePolicyArtifact = {
		scope: { mode: 'dimension', dimension: 'note', key: 'id', container: { dimension: 'workspace', column: 'workspace_id' } },
		actions: { read: 'notes.read', insert: 'notes.write', update: null, delete: null },
		insert: [],
		update: [],
		version: null,
		createdBy: null,
		columns: {},
	}
	const tables = { applications: INBOX, notes: NOTES }
	const CHALLENGED = ", challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET' }"
	const PHOTOS =
		`\tfiles: { photos: c.files({ owner: 'notes', read: 'notes.read', write: 'notes.write', delete: 'notes.delete', maxBytes: 4096, types: ['image/jpeg'], scan: true }) },`
	const withFiles = (files: string): string => edited(HEALTH, `${HEALTH}\n${PHOTOS}`, FORM(`${CHALLENGED}${files}`))

	test('a new file field widens and names its collection; requiring it narrows; a removed one narrows', () => {
		const plain = snapshot(withFiles(''), tables)
		const taking = snapshot(withFiles(", files: { photo: { collection: 'photos' } }"), tables)
		const requiring = snapshot(withFiles(", files: { photo: { collection: 'photos', required: true } }"), tables)
		const added = classifyAccess(plain, taking)
		expect(added.outcome).toBe('widening')
		expect(added.changes).toContainEqual({ widens: true, line: 'Form `apply` takes a file `photo` from anyone into files `photos`' })
		expect(classifyAccess(taking, requiring).changes).toContainEqual({ widens: false, line: 'Form `apply` requires its file `photo`' })
		expect(classifyAccess(requiring, taking).changes).toContainEqual({ widens: true, line: 'Form `apply` no longer requires its file `photo`' })
		expect(classifyAccess(taking, plain).changes).toContainEqual({
			widens: false,
			line: 'Form `apply` no longer takes a file `photo` into files `photos`',
		})
	})

	test('a new form names the collections it takes files into', () => {
		const base = snapshot(edited(HEALTH, `${HEALTH}\n${PHOTOS}`), { notes: NOTES })
		const changes = classifyAccess(base, snapshot(withFiles(", files: { photo: { collection: 'photos' } }"), tables)).changes
		expect(changes).toContainEqual({ widens: true, line: 'New form mount `apply`, taking files from anyone: `photo` into files `photos`' })
	})
})
