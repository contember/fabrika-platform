import { describe, expect, test } from 'bun:test'
import { artifactAccessDigest } from '../artifact-access'
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
})
