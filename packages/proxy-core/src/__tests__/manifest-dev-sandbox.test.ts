/**
 * The dev sandbox entry: one contract entry per workspace, `dev:<app>:<workspace>`, minting for the application's one
 * `<app>@<env>` audience and dialling its sandbox under a fixed upstream `Host`.
 */

import { describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import {
	audienceOf,
	type ContractEntryPlacement,
	contractProxyEntry,
	contractProxyTable,
	devSandboxEntryId,
	parseDevSandboxEntryId,
	parseProxyManifest,
} from '../manifest'
import { APP, contractAppWith, installationAppWith } from './helpers'

const WORKSPACE = '01934f6e-7b1a-7c3d-8e4f-0123456789ab'
const OTHER_WORKSPACE = '01934f6e-7b1a-7c3d-8e4f-ba9876543210'
const DEV_ID = `dev:notes:${WORKSPACE}`
const UPSTREAM_HOST = '3000-sbx1.box.example.com'

const DEV_ENTRY = contractAppWith([], [], {
	id: DEV_ID,
	hosts: [`${WORKSPACE}.dev.example.com`],
	audience: 'notes@dev',
	upstream: 'zbox:8081',
	upstreamHost: UPSTREAM_HOST,
})

/** On the wire: an override may be any value, and `undefined` drops the key. */
const devEntry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
	const entry: Record<string, unknown> = { ...DEV_ENTRY, ...overrides }
	for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete entry[key]
	return entry
}

const parses = (app: unknown): boolean => parseProxyManifest({ apps: [app] }) !== null

describe('dev sandbox entries — accepts', () => {
	test('a dev id with its audience and upstream host, preserved as written', () => {
		expect(parseProxyManifest({ apps: [DEV_ENTRY] })).toEqual({ apps: [DEV_ENTRY] })
	})

	test('a dev id with an audience and no upstream host', () => {
		expect(parses(devEntry({ upstreamHost: undefined }))).toBe(true)
	})

	test('an upstream host on an ordinary application entry', () => {
		expect(parses(contractAppWith([], [], { id: 'notes@prod', upstreamHost: UPSTREAM_HOST }))).toBe(true)
	})

	test('a plain id without an audience, as before', () => {
		expect(parses(contractAppWith([], [], { id: APP }))).toBe(true)
	})

	test('two workspaces of one application: one audience, two ids, two hosts', () => {
		const first = devEntry()
		const second = devEntry({ id: `dev:notes:${OTHER_WORKSPACE}`, hosts: [`${OTHER_WORKSPACE}.dev.example.com`] })
		expect(parseProxyManifest({ apps: [first, second] })?.apps).toHaveLength(2)
	})
})

describe('dev sandbox entries — refuses', () => {
	test.each<[string, Record<string, unknown>]>([
		['an audience on an <app>@<env> id, which already is its audience', { id: 'notes@dev' }],
		['an audience on a plain id', { id: APP }],
		['a dev id without an audience', { audience: undefined }],
		['an audience with no environment', { audience: 'notes' }],
		['an audience with an empty environment', { audience: 'notes@' }],
		['an audience with two @', { audience: 'notes@dev@eu' }],
		["an audience of another application than the id's", { audience: 'crm@dev' }],
		['an empty audience', { audience: '' }],
		['a non-string audience', { audience: 42 }],
		['an upstream host with a port', { upstreamHost: 'sbx.example.com:3000' }],
		['an upstream host that is a pattern', { upstreamHost: '*.example.com' }],
		['an upper-case upstream host', { upstreamHost: '3000-SBX1.box.example.com' }],
		['an empty upstream host', { upstreamHost: '' }],
		['an upstream host with a path', { upstreamHost: 'sbx.example.com/x' }],
	])('%s', (_, overrides) => {
		expect(parses(devEntry(overrides))).toBe(false)
	})

	test.each([
		`dev:notes:${WORKSPACE.toUpperCase()}`,
		`dev:notes:${WORKSPACE.slice(1)}`,
		`dev:notes:${WORKSPACE}:x`,
		`dev:Notes:${WORKSPACE}`,
		`dev:-notes:${WORKSPACE}`,
		`dev::${WORKSPACE}`,
		'dev:notes:',
		`prod:notes:${WORKSPACE}`,
		`notes:${WORKSPACE}`,
		`dev:notes_x:${WORKSPACE}`,
	])('a malformed dev id with an audience: %s', (id) => {
		expect(parses(devEntry({ id }))).toBe(false)
	})

	test('an audience or upstream host on an installation entry, whose schema has neither key', () => {
		expect(parses({ ...installationAppWith([]), audience: 'notes@dev' })).toBe(false)
		expect(parses({ ...installationAppWith([]), upstreamHost: UPSTREAM_HOST })).toBe(false)
	})

	test('two entries with one dev id', () => {
		const second = devEntry({ hosts: [`${OTHER_WORKSPACE}.dev.example.com`] })
		expect(parseProxyManifest({ apps: [devEntry(), second] })).toBeNull()
	})
})

describe('devSandboxEntryId', () => {
	test('builds the id the parser reads back', () => {
		expect(devSandboxEntryId('notes', WORKSPACE)).toBe(DEV_ID)
		expect(parseDevSandboxEntryId(DEV_ID)).toEqual({ appId: 'notes', workspaceId: WORKSPACE })
	})

	test('throws on a part that would not parse back', () => {
		expect(() => devSandboxEntryId('notes@dev', WORKSPACE)).toThrow()
		expect(() => devSandboxEntryId('notes', 'not-a-uuid')).toThrow()
		expect(() => devSandboxEntryId('no:tes', WORKSPACE)).toThrow()
	})

	test('reads no other id as a dev sandbox', () => {
		expect(parseDevSandboxEntryId('notes@dev')).toBeNull()
		expect(parseDevSandboxEntryId(APP)).toBeNull()
	})
})

describe('audienceOf', () => {
	test("a dev sandbox entry's audience, every other entry's id", () => {
		expect(audienceOf(DEV_ENTRY)).toBe('notes@dev')
		expect(audienceOf(contractAppWith([], [], { id: 'notes@prod' }))).toBe('notes@prod')
		expect(audienceOf(installationAppWith([], [], { id: 'iam' }))).toBe('iam')
	})
})

describe('contractProxyEntry — a dev sandbox placement', () => {
	const placement: ContractEntryPlacement = {
		id: DEV_ID,
		hosts: [`${WORKSPACE}.dev.example.com`],
		upstream: 'zbox:8081',
		scheme: 'https',
		table: contractProxyTable(notesArtifact),
		audience: 'notes@dev',
		upstreamHost: UPSTREAM_HOST,
	}

	test('passes the audience and the upstream host through, and the parser reads the entry back', () => {
		const entry = contractProxyEntry(placement)
		expect(entry).toMatchObject({ id: DEV_ID, audience: 'notes@dev', upstreamHost: UPSTREAM_HOST })
		expect(parseProxyManifest({ apps: [entry] })).toEqual({ apps: [entry] })
	})

	test('omits both when absent', () => {
		const { audience: _audience, upstreamHost: _upstreamHost, ...plain } = placement
		const entry = contractProxyEntry({ ...plain, id: 'notes@prod' })
		expect(entry).not.toHaveProperty('audience')
		expect(entry).not.toHaveProperty('upstreamHost')
	})

	test('refuses what the parser refuses, naming the field', () => {
		const { audience: _audience, ...withoutAudience } = placement
		expect(() => contractProxyEntry(withoutAudience)).toThrow(
			`proxy entry \`${DEV_ID}\` is one the proxy manifest refuses (audience)`,
		)
		expect(() => contractProxyEntry({ ...placement, upstreamHost: 'Box:3000' })).toThrow('(upstreamHost)')
	})
})
