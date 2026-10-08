import { describe, expect, test } from 'bun:test'
import { appEnvironmentId, isAppEnvironmentPart, parseAppEnvironmentId } from '../app-environment'

describe('appEnvironmentId', () => {
	test('joins the application and the environment with @', () => {
		expect(appEnvironmentId('notes', 'prod')).toBe('notes@prod')
	})

	test.each([
		['an empty application', '', 'prod'],
		['an empty environment', 'notes', ''],
		['an @ in the application', 'no@tes', 'prod'],
		['an @ in the environment', 'notes', 'pr@od'],
	])('refuses %s', (_name, app, env) => {
		expect(() => appEnvironmentId(app, env)).toThrow("must not contain '@'")
	})
})

describe('parseAppEnvironmentId', () => {
	test('reads back what appEnvironmentId built', () => {
		expect(parseAppEnvironmentId(appEnvironmentId('example-app', 'stage'))).toEqual({ app: 'example-app', env: 'stage' })
	})

	test.each([
		['a platform audience', 'vozka'],
		['an empty application', '@prod'],
		['an empty environment', 'notes@'],
		['two separators', 'notes@prod@eu'],
		['an empty string', ''],
	])('answers null for %s', (_name, id) => {
		expect(parseAppEnvironmentId(id)).toBeNull()
	})
})

describe('isAppEnvironmentPart', () => {
	test('accepts a plain name and refuses an empty one or one with @', () => {
		expect(isAppEnvironmentPart('notes')).toBe(true)
		expect(isAppEnvironmentPart('')).toBe(false)
		expect(isAppEnvironmentPart('notes@prod')).toBe(false)
	})
})
