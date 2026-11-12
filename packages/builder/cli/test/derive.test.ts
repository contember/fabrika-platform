import { afterEach, expect, test } from 'bun:test'
import { symlinkSync } from 'fs'
import { join } from 'path'
import { type Approvals, InvalidApprovalsError, readApprovals, writeApprovals } from '../../shared/approvals'
import { derivePhase, type GateProbe, isNonEmptyFile, matchGlob, phaseInputs, producesSatisfied } from '../../shared/derive'
import { phaseById, type PhaseId } from '../../shared/phases'
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
	fx.write('tests/browser/login.test.ts')
	fx.write('.fabrika/issues/ISSUE-001.md')

	const state = derivePhase(fx.root)
	expect(state.current).toBe('build')
	expect(state.completed).toEqual([
		'intake',
		'vision',
		'flows',
		'tech',
		'skeletons',
		'issues',
	])
})

test('self-correcting: emptying tech.md re-targets phase 4 (tech)', () => {
	fx = makeFixture()
	fx.write('.fabrika/intent/brief.md')
	fx.write('.fabrika/intent/glossary.md')
	fx.write('.fabrika/principles/principles.md')
	fx.write('.fabrika/architecture/flows/login.flow.md')
	fx.write('.fabrika/architecture/tech.md')
	let state = derivePhase(fx.root)
	expect(state.current).toBe('skeletons')

	fx.writeEmpty('.fabrika/architecture/tech.md')
	state = derivePhase(fx.root)
	expect(state.current).toBe('tech')
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

const reviewed: GateProbe = () => ({ reviewed: true, verdict: 'approve', revision: 1 })
const unreviewed: GateProbe = () => ({ reviewed: false, verdict: 'none', revision: 1 })

function approve(root: string, ids: PhaseId[], waived = false): void {
	const approvals: Approvals = { ...readApprovals(root) }
	for (const id of ids) {
		approvals[id] = { at: '2026-01-01T00:00:00.000Z', inputs: phaseInputs(root, phaseById(id)), ...(waived ? { waived: true } : {}) }
	}
	writeApprovals(root, approvals)
}

function writeThroughSkeletons(f: Fixture): void {
	f.write('.fabrika/intent/brief.md')
	f.write('.fabrika/intent/glossary.md')
	f.write('.fabrika/principles/principles.md')
	f.write('.fabrika/architecture/flows/login.flow.md')
	f.write('.fabrika/architecture/tech.md')
	f.write('tests/browser/login.test.ts')
}

test('with approvals kept, a reviewed gate stays current until advance approves it', () => {
	fx = makeFixture(true, { approvals: true })
	fx.write('.fabrika/intent/brief.md')
	let state = derivePhase(fx.root, reviewed)
	expect(state.current).toBe('intake')
	expect(state.satisfied).toBe(true)
	expect(state.stale).toEqual([])

	approve(fx.root, ['intake'])
	state = derivePhase(fx.root, reviewed)
	expect(state.current).toBe('vision')
	expect(state.completed).toEqual(['intake'])
})

test('an approved phase whose produced or read files changed is current again, earliest first', () => {
	fx = makeFixture(true, { approvals: true })
	writeThroughSkeletons(fx)
	approve(fx.root, ['intake', 'vision', 'flows', 'tech', 'skeletons'])
	expect(derivePhase(fx.root, reviewed).current).toBe('issues')

	// A flow edited after the skeletons were approved re-opens the flows gate, not only the phases that read it.
	fx.write('.fabrika/architecture/flows/login.flow.md', 'a changed flow')
	let state = derivePhase(fx.root, reviewed)
	expect(state.current).toBe('flows')
	expect(state.completed).toEqual(['intake', 'vision'])
	expect(state.stale).toEqual(['.fabrika/architecture/flows/login.flow.md'])

	approve(fx.root, ['flows'])
	state = derivePhase(fx.root, reviewed)
	expect(state.current).toBe('tech')
	expect(state.stale).toEqual(['.fabrika/architecture/flows/login.flow.md'])

	// A new input counts as a change too.
	approve(fx.root, ['tech', 'skeletons'])
	fx.write('.fabrika/architecture/flows/signup.flow.md')
	expect(derivePhase(fx.root, reviewed).stale).toEqual(['.fabrika/architecture/flows/signup.flow.md'])
})

test('the build filling in a skeleton does not re-open the skeletons gate', () => {
	fx = makeFixture(true, { approvals: true })
	writeThroughSkeletons(fx)
	fx.write('.fabrika/issues/ISSUE-001.md')
	approve(fx.root, ['intake', 'vision', 'flows', 'tech', 'skeletons'])
	fx.write('tests/browser/login.test.ts', 'step bodies filled in')
	expect(derivePhase(fx.root, reviewed).current).toBe('build')
})

test('a waived approval completes its phase without a review; a reviewed one still needs its review', () => {
	fx = makeFixture(true, { approvals: true })
	fx.write('.fabrika/intent/brief.md')
	approve(fx.root, ['intake'], true)
	expect(derivePhase(fx.root, unreviewed).current).toBe('vision')

	approve(fx.root, ['intake'])
	expect(derivePhase(fx.root, unreviewed).current).toBe('intake')
})

test('without the approvals file, gates are judged by their reviews alone', () => {
	fx = makeFixture()
	fx.write('.fabrika/intent/brief.md')
	expect(derivePhase(fx.root, reviewed).current).toBe('vision')
	expect(derivePhase(fx.root, unreviewed).current).toBe('intake')
})

test('an approvals file that does not parse, or of another version, is refused rather than read as empty', () => {
	fx = makeFixture(true, { approvals: true })
	fx.write('.fabrika/intent/brief.md')
	for (const content of ['<<<<<<< HEAD\n{}', JSON.stringify({ version: 2, phases: {} })]) {
		fx.write('.fabrika/approvals.json', content)
		expect(() => derivePhase(fx!.root, reviewed)).toThrow(InvalidApprovalsError)
	}
})

test('a record that does not parse reads as missing, and the others stay', () => {
	fx = makeFixture(true, { approvals: true })
	fx.write('.fabrika/intent/brief.md')
	approve(fx.root, ['intake'])
	const intake = readApprovals(fx.root)?.intake
	fx.write('.fabrika/approvals.json', JSON.stringify({ version: 1, phases: { intake, vision: { at: 1 } } }))
	expect(readApprovals(fx.root)).toEqual({ intake })
})

test('a dangling link under a hashed glob is not an input and does not break the derivation', () => {
	fx = makeFixture(true, { approvals: true })
	writeThroughSkeletons(fx)
	symlinkSync(join(fx.root, 'missing.md'), join(fx.root, '.fabrika/architecture/flows/broken.flow.md'))
	approve(fx.root, ['intake', 'vision', 'flows'])
	expect(Object.keys(phaseInputs(fx.root, phaseById('flows')))).not.toContain('.fabrika/architecture/flows/broken.flow.md')
	expect(derivePhase(fx.root, reviewed).current).toBe('tech')
})
