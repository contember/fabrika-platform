import { describe, expect, test } from 'bun:test'
import { artifactAccessDigest, DuplicateAccessIdentifierError } from '../artifact-access'
import type { AppSchema } from '../types'

const schema: AppSchema = { scopes: [], actions: [{ action: 'notes.read' }], roles: { reader: { name: 'Reader', permissions: ['notes.read'] } } }

describe('artifactAccessDigest', () => {
	test('ignores key order, but not gate order, which is precedence', () => {
		const gates = { rules: [{ path: '/healthz', kind: 'public' as const }, { path: '/*', kind: 'human' as const }] }
		const digest = artifactAccessDigest({ gates, schema })
		expect(artifactAccessDigest({ schema, gates: { rules: gates.rules.map((rule) => ({ kind: rule.kind, path: rule.path })) } })).toBe(digest)
		expect(artifactAccessDigest({ gates: { rules: [...gates.rules].reverse() }, schema })).not.toBe(digest)
		expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/)
	})

	test('every change to the gates or the schema changes it, and so does dropping either', () => {
		const gates = { rules: [{ path: '/*', kind: 'human' as const }] }
		const digests = new Set([
			artifactAccessDigest({ gates, schema }),
			artifactAccessDigest({ gates: { rules: [{ path: '/*', kind: 'public' }] }, schema }),
			artifactAccessDigest({ gates, schema: { ...schema, roles: { reader: { name: 'Reader', permissions: ['notes.read', 'notes.delete'] } } } }),
			artifactAccessDigest({ gates: null, schema }),
			artifactAccessDigest({ gates, schema: null }),
		])
		expect(digests.size).toBe(5)
	})

	test('sets and catalogs are sorted, so reordering one keeps the digest', () => {
		const ordered: AppSchema = {
			scopes: [{ type: 'note', in: 'workspace' }, { type: 'workspace', creator: 'owner' }],
			actions: [{ action: 'notes.read' }, { action: 'notes.share' }, { action: 'notes.write' }],
			roles: {
				owner: { name: 'Owner', permissions: ['notes.read', 'notes.write'], member: { scope: 'workspace', assignableBy: ['editor', 'owner'] } },
				editor: { name: 'Editor', permissions: ['notes.read'], member: { scope: 'workspace', assignableBy: ['owner'] } },
			},
			links: { share: { dimension: 'note', grants: ['notes.read', 'notes.write'], issuedBy: 'notes.share', maxDays: 7 } },
		}
		const reordered: AppSchema = {
			scopes: [...ordered.scopes].reverse(),
			actions: [...ordered.actions].reverse(),
			roles: {
				editor: { name: 'Editor', permissions: ['notes.read'], member: { scope: 'workspace', assignableBy: ['owner'] } },
				owner: { name: 'Owner', permissions: ['notes.write', 'notes.read'], member: { scope: 'workspace', assignableBy: ['owner', 'editor'] } },
			},
			links: { share: { dimension: 'note', grants: ['notes.write', 'notes.read'], issuedBy: 'notes.share', maxDays: 7 } },
		}
		const oauth = (scopes: string[]) => ({ rules: [{ path: '/mcp', kind: 'oauth' as const, resource: 'https://notes.example/mcp', scopes }] })
		expect(artifactAccessDigest({ gates: oauth(['notes:write', 'notes:read']), schema: reordered }))
			.toBe(artifactAccessDigest({ gates: oauth(['notes:read', 'notes:write']), schema: ordered }))
	})

	test('a repeated identifier is refused, not sorted away', () => {
		const repeats: readonly AppSchema[] = [
			{ ...schema, actions: [{ action: 'notes.read' }, { action: 'notes.read', description: 'Read' }] },
			{ ...schema, scopes: [{ type: 'workspace' }, { type: 'workspace', creator: 'owner' }] },
			{ ...schema, roles: { reader: { name: 'Reader', permissions: ['notes.read', 'notes.read'] } } },
			{ ...schema, roles: { reader: { name: 'Reader', permissions: [], member: { scope: 'workspace', assignableBy: ['owner', 'owner'] } } } },
			{ ...schema, links: { share: { dimension: 'note', grants: ['notes.read', 'notes.read'], issuedBy: 'notes.read', maxDays: 1 } } },
		]
		for (const repeated of repeats) {
			expect(() => artifactAccessDigest({ gates: null, schema: repeated })).toThrow(DuplicateAccessIdentifierError)
		}
		const gates = { rules: [{ path: '/mcp', kind: 'oauth' as const, resource: 'https://notes.example/mcp', scopes: ['notes:read', 'notes:read'] }] }
		expect(() => artifactAccessDigest({ gates, schema: null })).toThrow(DuplicateAccessIdentifierError)
	})
})
