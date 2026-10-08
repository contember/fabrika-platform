import { describe, expect, test } from 'bun:test'
import { resolveApp } from '../access/components/AppPicker'
import { resolveScope } from '../access/components/ScopePicker'
import { type GrantRow, parseShareLinkForm } from '../access/lib/share-link-form'

const blank: GrantRow = { action: ' ', scopeType: '', scopeValue: '' }
const global: GrantRow = { action: ' report.read ', scopeType: ' ', scopeValue: '' }

describe('share link form', () => {
	test('sends trimmed grants, explicit global scope, and omits blank optional request fields', () => {
		expect(
			parseShareLinkForm({
				rows: [blank, global, { action: ' report.write ', scopeType: ' tenant ', scopeValue: ' opaque:* ' }],
				app: 'reports',
				label: ' ',
				expiry: '',
			}),
		).toEqual({
			app: 'reports',
			grants: [{ action: 'report.read', scope: null }, { action: 'report.write', scope: { type: 'tenant', value: 'opaque:*' } }],
		})
	})

	test('sends expiry in seconds and preserves duplicate grants and app identity', () => {
		expect(parseShareLinkForm({ rows: [global, global], app: ' reports ', label: ' Review ', expiry: '2026-10-05T12:00:00Z' })).toEqual({
			app: ' reports ',
			grants: [{ action: 'report.read', scope: null }, { action: 'report.read', scope: null }],
			label: 'Review',
			expiresAt: 1791201600,
		})
		expect(parseShareLinkForm({ rows: [global], app: 'reports', label: '', expiry: 'invalid' })).not.toHaveProperty('expiresAt')
	})

	test('preserves validation order and exact form errors', () => {
		const parse = (rows: GrantRow[], app = '') => parseShareLinkForm({ rows, app, label: '', expiry: '' })
		expect(() => parse([blank])).toThrow('Add at least one grant.')
		expect(() => parse([{ action: '', scopeType: 'tenant', scopeValue: '' }])).toThrow('Each grant needs an action.')
		expect(() => parse([{ action: 'read', scopeType: 'tenant', scopeValue: '' }, { action: '', scopeType: '', scopeValue: 'x' }])).toThrow(
			'Each grant needs an action.',
		)
		for (const row of [{ action: 'read', scopeType: 'tenant', scopeValue: '' }, { action: 'read', scopeType: '', scopeValue: 'x' }]) {
			expect(() => parse([row])).toThrow('A scope needs both a dimension and a value, or leave both empty for a global grant.')
		}
		expect(() => parse([global])).toThrow('Choose the app this link is for.')
	})
})

test('scope and app pickers keep explicit global selection and opaque scope values', () => {
	expect(resolveApp({ kind: 'all' })).toBeNull()
	expect(resolveApp({ kind: 'app', app: 'reports' })).toBe('reports')
	expect(() => resolveApp({ kind: 'unset' })).toThrow('Pick an app first.')
	expect(resolveScope({ kind: 'global' })).toEqual({ scopeType: null, scopeValue: null })
	expect(resolveScope({ kind: 'scoped', type: ' tenant ', value: ' opaque:* ' })).toEqual({ scopeType: 'tenant', scopeValue: 'opaque:*' })
	expect(() => resolveScope({ kind: 'scoped', type: 'tenant', value: ' ' })).toThrow('Pick a scope dimension and enter a value, or choose Global.')
})
