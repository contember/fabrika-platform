import { describe, expect, test } from 'bun:test'
import { formatTimestamp, relativeSeen, severityColor } from '../format.js'

describe('Operations display formatting', () => {
	test('keeps Poplach severity fallbacks', () => {
		expect(severityColor('fatal')).toBe('var(--severity-fatal)')
		expect(severityColor('debug')).toBe('var(--severity-muted)')
	})

	test('formats relative and absolute timestamps deterministically', () => {
		const now = Date.UTC(2026, 6, 30, 12)
		expect(relativeSeen(now - 12 * 60_000, now)).toBe('12m ago')
		expect(relativeSeen(now - 5 * 60 * 60_000, now)).toBe('5h ago')
		expect(formatTimestamp(Date.UTC(2025, 0, 1))).toBe('2025-01-01 00:00:00 UTC')
	})
})
