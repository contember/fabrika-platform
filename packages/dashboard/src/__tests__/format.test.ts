import { describe, expect, test } from 'bun:test'
import { fmtAgo, fmtDuration, shortRef, shortSha } from '../lib/format'

// Pure formatting helpers used across the dashboard. No DOM, just the deterministic transforms.

describe('shortSha', () => {
	test('takes the first 7 chars', () => {
		expect(shortSha('0123456789abcdef')).toBe('0123456')
	})
	test('renders an em dash for null/empty', () => {
		expect(shortSha(null)).toBe('none')
		expect(shortSha('')).toBe('none')
		expect(shortSha(undefined)).toBe('none')
	})
})

describe('shortRef', () => {
	test('drops the refs/heads/ prefix', () => {
		expect(shortRef('refs/heads/main')).toBe('main')
		expect(shortRef('refs/heads/deploy/prod')).toBe('deploy/prod')
	})
	test('drops the refs/tags/ prefix', () => {
		expect(shortRef('refs/tags/v1.2.3')).toBe('v1.2.3')
	})
	test('leaves a bare ref untouched', () => {
		expect(shortRef('main')).toBe('main')
		expect(shortRef('deadbeef')).toBe('deadbeef')
	})
})

describe('fmtDuration', () => {
	test('seconds only under a minute', () => {
		expect(fmtDuration(100, 142)).toBe('42s')
	})
	test('minutes and seconds past a minute', () => {
		expect(fmtDuration(100, 172)).toBe('1m 12s')
	})
	test('clamps a negative span to zero', () => {
		expect(fmtDuration(200, 100)).toBe('0s')
	})
	test('em dash when either bound is missing', () => {
		expect(fmtDuration(null, 100)).toBe('none')
		expect(fmtDuration(100, null)).toBe('none')
		expect(fmtDuration(undefined, undefined)).toBe('none')
	})
})

describe('fmtAgo', () => {
	const nowMs = Date.UTC(2026, 6, 30, 12)
	const nowSeconds = nowMs / 1000
	test('counts minutes, hours and days back from now', () => {
		expect(fmtAgo(nowSeconds - 12 * 60, nowMs)).toBe('12m ago')
		expect(fmtAgo(nowSeconds - 5 * 60 * 60, nowMs)).toBe('5h ago')
		expect(fmtAgo(nowSeconds - 3 * 86_400, nowMs)).toBe('3d ago')
	})
	test('never shows zero minutes between the just-now window and one minute', () => {
		expect(fmtAgo(nowSeconds - 50, nowMs)).toBe('1m ago')
	})
	test('accepts a millisecond stamp scaled to fractional seconds', () => {
		expect(fmtAgo((nowMs - 12 * 60_000) / 1000, nowMs)).toBe('12m ago')
	})
	test('em dash when absent', () => {
		expect(fmtAgo(null, nowMs)).toBe('none')
	})
})
