import { afterEach, expect, test } from 'bun:test'
import { isReady, readIssues } from '../src/issues'
import { type Fixture, makeFixture } from './helpers'

let fx: Fixture | null = null
afterEach(() => fx?.cleanup())

test('readIssues parses front-matter (goal/satisfies/depends_on/touches)', () => {
	fx = makeFixture()
	fx.write(
		'.fabrika/issues/ISSUE-007.md',
		[
			'---',
			'goal: build the cart',
			'satisfies: [cart-add, cart-total-invariant]',
			'depends_on: [ISSUE-002, ISSUE-004]',
			'touches: [routes/cart, db/cart]',
			'---',
			'Some prose body.',
		].join('\n'),
	)
	const issues = readIssues(fx.fabrikaDir)
	expect(issues.length).toBe(1)
	const i = issues[0]!
	expect(i.id).toBe('ISSUE-007')
	expect(i.goal).toBe('build the cart')
	expect(i.satisfies).toEqual(['cart-add', 'cart-total-invariant'])
	expect(i.dependsOn).toEqual(['ISSUE-002', 'ISSUE-004'])
	expect(i.touches).toEqual(['routes/cart', 'db/cart'])
	expect(i.body).toBe('Some prose body.')
})

test('isReady gates on presence of all depends_on ids', () => {
	fx = makeFixture()
	fx.write('.fabrika/issues/ISSUE-001.md', '---\ngoal: a\ndepends_on: []\n---\n')
	fx.write('.fabrika/issues/ISSUE-002.md', '---\ngoal: b\ndepends_on: [ISSUE-001]\n---\n')
	fx.write('.fabrika/issues/ISSUE-003.md', '---\ngoal: c\ndepends_on: [ISSUE-999]\n---\n')
	const issues = readIssues(fx.fabrikaDir)
	const known = new Set(issues.map((i) => i.id))
	const byId = Object.fromEntries(issues.map((i) => [i.id, i]))
	expect(isReady(byId['ISSUE-001']!, known)).toBe(true)
	expect(isReady(byId['ISSUE-002']!, known)).toBe(true)
	expect(isReady(byId['ISSUE-003']!, known)).toBe(false) // ISSUE-999 missing
})

test('empty issue files are ignored', () => {
	fx = makeFixture()
	fx.writeEmpty('.fabrika/issues/ISSUE-001.md')
	expect(readIssues(fx.fabrikaDir).length).toBe(0)
})
