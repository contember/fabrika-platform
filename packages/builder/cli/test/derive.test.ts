import { afterEach, expect, test } from 'bun:test'
import { join } from 'path'
import { derivePhase, isNonEmptyFile, matchGlob, producesSatisfied } from '../src/derive'
import { phaseById } from '../src/phases'
import { type Fixture, makeFixture } from './helpers'

let fx: Fixture | null = null
afterEach(() => fx?.cleanup())

test('empty .fabrika/ -> current phase is intake', () => {
	fx = makeFixture()
	const state = derivePhase(fx.root)
	expect(state.current).toBe('intake')
	expect(state.index).toBe(0)
	expect(state.completed).toEqual([])
	expect(state.satisfied).toBe(false)
})

test('brief.md present -> current phase is vision; intake completed', () => {
	fx = makeFixture()
	fx.write('.fabrika/intent/brief.md', '# brief')
	const state = derivePhase(fx.root)
	expect(state.current).toBe('vision')
	expect(state.completed).toEqual(['intake'])
})

test('vision needs BOTH glossary AND principles (all produces globs)', () => {
	fx = makeFixture()
	fx.write('.fabrika/intent/brief.md')
	fx.write('.fabrika/intent/glossary.md') // only one of two produces
	let state = derivePhase(fx.root)
	expect(state.current).toBe('vision') // not satisfied yet

	fx.write('.fabrika/principles/principles.md')
	state = derivePhase(fx.root)
	expect(state.current).toBe('flows')
	expect(state.completed).toEqual(['intake', 'vision'])
})

test('flows is glob-satisfied by >=1 *.flow.md', () => {
	fx = makeFixture()
	fx.write('.fabrika/intent/brief.md')
	fx.write('.fabrika/intent/glossary.md')
	fx.write('.fabrika/principles/principles.md')
	fx.write('.fabrika/architecture/flows/login.flow.md')
	const state = derivePhase(fx.root)
	expect(state.current).toBe('tech')
	expect(state.completed).toEqual(['intake', 'vision', 'flows'])
})

test('full chain through to skeletons/issues; build is terminal', () => {
	fx = makeFixture()
	fx.write('.fabrika/intent/brief.md')
	fx.write('.fabrika/intent/glossary.md')
	fx.write('.fabrika/principles/principles.md')
	fx.write('.fabrika/architecture/flows/login.flow.md')
	fx.write('.fabrika/architecture/tech.md')
	fx.write('.fabrika/architecture/design.md')
	fx.write('.fabrika/pages/home.jsx')
	fx.write('tests/browser/login.test.ts')
	fx.write('.fabrika/issues/ISSUE-001.md')

	const state = derivePhase(fx.root)
	expect(state.current).toBe('build')
	expect(state.completed).toEqual([
		'intake',
		'vision',
		'flows',
		'tech',
		'design',
		'skeletons',
		'issues',
	])
})

test('self-correcting: deleting design.md re-targets phase 5 (design)', () => {
	fx = makeFixture()
	fx.write('.fabrika/intent/brief.md')
	fx.write('.fabrika/intent/glossary.md')
	fx.write('.fabrika/principles/principles.md')
	fx.write('.fabrika/architecture/flows/login.flow.md')
	fx.write('.fabrika/architecture/tech.md')
	fx.write('.fabrika/architecture/design.md')
	fx.write('.fabrika/pages/home.jsx')
	let state = derivePhase(fx.root)
	expect(state.current).toBe('skeletons')

	fx.writeEmpty('.fabrika/architecture/design.md')
	state = derivePhase(fx.root)
	expect(state.current).toBe('design')
})

test('empty files do NOT satisfy produces', () => {
	fx = makeFixture()
	fx.writeEmpty('.fabrika/intent/brief.md')
	const state = derivePhase(fx.root)
	expect(state.current).toBe('intake') // empty brief doesn't count
})

test('producesSatisfied / isNonEmptyFile primitives', () => {
	fx = makeFixture()
	fx.write('.fabrika/intent/brief.md', 'content')
	expect(isNonEmptyFile(join(fx.root, '.fabrika/intent/brief.md'))).toBe(true)
	expect(producesSatisfied(fx.root, phaseById('intake'))).toBe(true)
	expect(producesSatisfied(fx.root, phaseById('vision'))).toBe(false)
})

test('matchGlob resolves *.flow.md and ISSUE-*.md shapes', () => {
	fx = makeFixture()
	fx.write('.fabrika/architecture/flows/a.flow.md')
	fx.write('.fabrika/architecture/flows/b.flow.md')
	fx.write('.fabrika/architecture/flows/notes.md') // should not match
	const flows = matchGlob(fx.root, '.fabrika/architecture/flows/*.flow.md')
	expect(flows.length).toBe(2)

	fx.write('.fabrika/issues/ISSUE-001.md')
	fx.write('.fabrika/issues/ISSUE-002.md')
	fx.write('.fabrika/issues/README.md') // should not match
	const issues = matchGlob(fx.root, '.fabrika/issues/ISSUE-*.md')
	expect(issues.length).toBe(2)
})

test('build phase produces is a placeholder -> never auto-satisfied from FS', () => {
	fx = makeFixture()
	expect(producesSatisfied(fx.root, phaseById('build'))).toBe(false)
})
