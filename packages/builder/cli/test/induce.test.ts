import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { StackPointer } from '../src/catalog'
import { induceIssues, renderIssue } from '../src/induce'
import { parseIssue } from '../src/issues'
import { readSkeletons } from '../src/skeletons'

function fixture(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), 'fab-induce-'))
	const tb = join(dir, 'tests', 'browser')
	mkdirSync(tb, { recursive: true })
	for (const [name, src] of Object.entries(files)) writeFileSync(join(tb, name), src)
	return tb
}

const CHECKOUT = `import { browserTest, invariant, step } from '@opice/harness'
const BASE = process.env.APP_URL ?? 'http://localhost:5173'
browserTest(
  { name: 'shopper checks out', url: \`\${BASE}/cart\`, seeds: ['catalog', 'saved-card'], roles: ['shopper'], feature: 'F-CHK-02' },
  async () => {
    await step('pay', { intent: 'completes' })
    await invariant.todo('card PAN is never rendered', 'mask it')
  }
)`

const BROWSE = `import { browserTest, step } from '@opice/harness'
browserTest(
  { name: 'browses menu', url: 'http://localhost:5173/admin/products', seeds: ['catalog'] },
  async () => { await step('lists', { intent: 'renders' }) }
)`

describe('skeleton parsing', () => {
	test('extracts metadata + reduces url to a route path', () => {
		const tb = fixture({ 'checkout.test.ts': CHECKOUT })
		const [s] = readSkeletons(tb)
		expect(s!.name).toBe('shopper checks out')
		expect(s!.url).toBe('/cart') // ${BASE}/cart reduced
		expect(s!.seeds).toEqual(['catalog', 'saved-card'])
		expect(s!.roles).toEqual(['shopper'])
		expect(s!.feature).toBe('F-CHK-02')
		expect(s!.invariants).toEqual(['card PAN is never rendered'])
		rmSync(tb, { recursive: true, force: true })
	})

	test('reduces a full http url (with host) to its path', () => {
		const tb = fixture({ 'browse.test.ts': BROWSE })
		const [s] = readSkeletons(tb)
		expect(s!.url).toBe('/admin/products')
		rmSync(tb, { recursive: true, force: true })
	})
})

describe('issue induction', () => {
	test('induces ordered foundation + feature issues', () => {
		const tb = fixture({ 'checkout.test.ts': CHECKOUT, 'browse.test.ts': BROWSE })
		const skeletons = readSkeletons(tb)
		const issues = induceIssues(skeletons)

		const ids = issues.map((i) => i.id)
		expect(ids).toEqual(['ISSUE-001', 'ISSUE-002', 'ISSUE-003', 'ISSUE-004', 'ISSUE-101', 'ISSUE-102'])

		const scaffold = issues.find((i) => i.id === 'ISSUE-001')!
		expect(scaffold.dependsOn).toEqual([])
		expect(scaffold.kind).toBe('foundation')
		expect(scaffold.verify).toEqual([])

		const design = issues.find((i) => i.id === 'ISSUE-004')!
		expect(design.kind).toBe('foundation')
		expect(design.gate).toBe('design-checkpoint')
		expect(design.dependsOn).toEqual(['ISSUE-001', 'ISSUE-002', 'ISSUE-003'])
		expect(design.verify).toEqual([])
		expect(design.body).toContain('`/cart`')

		const checkout = issues.find((i) => i.satisfies.includes('F-CHK-02'))!
		expect(checkout.kind).toBe('feature')
		expect(checkout.dependsOn).toEqual(['ISSUE-001', 'ISSUE-002', 'ISSUE-003', 'ISSUE-004'])
		expect(checkout.satisfies).toContain('card PAN is never rendered')
		expect(checkout.verify).toEqual(['tests/browser/checkout.test.ts'])

		const browse = issues.find((i) => i.satisfies.includes('browses menu'))!
		expect(browse.dependsOn).toEqual(['ISSUE-001', 'ISSUE-002', 'ISSUE-004'])

		rmSync(tb, { recursive: true, force: true })
	})

	test('renders parseable front-matter', () => {
		const issues = induceIssues([
			{ file: 'tests/browser/x.test.ts', name: 'x', url: '/x', seeds: [], roles: [], invariants: ['inv-a'] },
		])
		const md = renderIssue(issues.find((i) => i.kind === 'feature')!)
		expect(md).toContain('satisfies: ["x", "inv-a"]')
		expect(md).toContain('depends_on: ["ISSUE-001", "ISSUE-004"]')
		expect(md).toContain('verify: ["tests/browser/x.test.ts"]')
		const dir = mkdtempSync(join(tmpdir(), 'fabrika-issue-'))
		writeFileSync(join(dir, 'ISSUE-101.md'), md)
		expect(parseIssue(join(dir, 'ISSUE-101.md')).verify).toEqual(['tests/browser/x.test.ts'])
		const design = renderIssue(issues.find((i) => i.id === 'ISSUE-004')!)
		expect(design).toContain('gate: design-checkpoint')
		writeFileSync(join(dir, 'ISSUE-004.md'), design)
		expect(parseIssue(join(dir, 'ISSUE-004.md')).gate).toBe('design-checkpoint')
		expect(parseIssue(join(dir, 'ISSUE-101.md')).gate).toBeUndefined()
		rmSync(dir, { recursive: true, force: true })
	})

	test('no skeletons → no issues', () => {
		expect(induceIssues([])).toEqual([])
	})

	test('a resolved stack pointer is embedded in the foundation scaffold body', () => {
		const stack: StackPointer = {
			profile: 'cf-fat',
			root: '/abs/fabrika',
			stackFile: '/abs/fabrika/stacks/cf-fat.md',
			stackFileExists: true,
			decisionsDir: '/abs/fabrika/decisions',
			support: 'unsupported',
		}
		const issues = induceIssues(
			[{ file: 'tests/browser/x.test.ts', name: 'x', url: '/x', seeds: [], roles: [], invariants: [] }],
			{ stack },
		)
		const scaffold = issues.find((i) => i.id === 'ISSUE-001')!
		expect(scaffold.body).toContain('Stack preset: /abs/fabrika/stacks/cf-fat.md')
		expect(scaffold.body).toContain('/abs/fabrika/decisions/')
	})

	test('an unknown stack (file missing) embeds no pointer', () => {
		const stack: StackPointer = {
			profile: 'nope',
			root: '/abs/fabrika',
			stackFile: '/abs/fabrika/stacks/nope.md',
			stackFileExists: false,
			decisionsDir: '/abs/fabrika/decisions',
			support: null,
		}
		const issues = induceIssues(
			[{ file: 'tests/browser/x.test.ts', name: 'x', url: '/x', seeds: [], roles: [], invariants: [] }],
			{ stack },
		)
		const scaffold = issues.find((i) => i.id === 'ISSUE-001')!
		expect(scaffold.body).not.toContain('Stack preset:')
	})
})
