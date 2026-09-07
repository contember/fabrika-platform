import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { isInitialized, LAYER_DIRS, readConfig, scaffold } from '../src/layout'
import { type Fixture, makeFixture } from './helpers'

let fx: Fixture | null = null
afterEach(() => fx?.cleanup())

test('init creates the .fabrika/ layer layout', () => {
	fx = makeFixture(false)
	const result = scaffold(fx.root, { profile: 'cf-lightweight', sessionId: 's_x' })

	expect(existsSync(join(fx.root, '.fabrika'))).toBe(true)
	for (const dir of LAYER_DIRS) {
		expect(existsSync(join(fx.root, '.fabrika', dir))).toBe(true)
	}
	expect(existsSync(join(fx.root, 'tests', 'browser'))).toBe(true)
	expect(result.createdConfig).toBe(true)
})

test('init writes config.json with profile/sessionId/createdAt (not a phase pointer)', () => {
	fx = makeFixture(false)
	scaffold(fx.root, { profile: 'cf-lightweight', sessionId: 's_abc' })

	const cfg = readConfig(fx.root)
	expect(cfg).not.toBeNull()
	expect(cfg!.profile).toBe('cf-lightweight')
	expect(cfg!.sessionId).toBe('s_abc')
	expect(typeof cfg!.createdAt).toBe('string')
	expect(Object.keys(cfg ?? {})).not.toContain('phase')
	expect(Object.keys(cfg ?? {})).not.toContain('current')
})

test('init is idempotent: never clobbers existing artifacts', () => {
	fx = makeFixture(false)
	scaffold(fx.root, { profile: 'cf-lightweight', sessionId: 's_first' })

	const cfgPath = join(fx.root, '.fabrika', 'config.json')
	const briefPath = join(fx.root, '.fabrika', 'intent', 'brief.md')
	writeFileSync(briefPath, '# my brief')

	const second = scaffold(fx.root, { profile: 'other', sessionId: 's_second' })
	expect(second.createdConfig).toBe(false)
	expect(second.alreadyInitialized).toBe(true)

	const cfg = readConfig(fx.root)!
	expect(cfg.profile).toBe('cf-lightweight') // unchanged
	expect(cfg.sessionId).toBe('s_first') // unchanged
	expect(readFileSync(briefPath, 'utf-8')).toBe('# my brief') // unchanged
})

test('isInitialized reflects config.json presence', () => {
	fx = makeFixture(false)
	expect(isInitialized(fx.root)).toBe(false)
	scaffold(fx.root, { sessionId: 's_y' })
	expect(isInitialized(fx.root)).toBe(true)
})
