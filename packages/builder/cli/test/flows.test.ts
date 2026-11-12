import { compileJsx } from '@fabrika/canvas-kernel/server'
import { afterEach, expect, test } from 'bun:test'
import { symlinkSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { mappedRoutes, parseFlow, readFlows, renderFlowsReview, routeMapMermaid, unmappedUrls } from '../src/flows'
import { type Fixture, makeFixture } from './helpers'

const BIN = fileURLToPath(new URL('../src/bin.ts', import.meta.url))

let fx: Fixture | null = null
afterEach(() => fx?.cleanup())

const flow = (fm: string, body = '# Steps\n\n1. Act.') => `---\n${fm}\n---\n${body}\n`

test('a flow names its start and the screens it leads to; anything not a path is a problem, never a node', () => {
	const ok = parseFlow('checkout', flow('actor: shopper\ngoal: checks out\nroute: /cart\nleads_to: [/checkout, "/orders/:id"]'))
	expect(ok).toMatchObject({ actor: 'shopper', goal: 'checks out', route: '/cart', leadsTo: ['/checkout', '/orders/:id'], problems: [] })

	expect(parseFlow('browse', flow('actor: shopper')).problems).toEqual(['no `route:` in its front matter'])
	const bad = parseFlow('Bad Name', flow('route: cart"]\nleads_to: [/ok, javascript:x]'))
	expect(bad.route).toBeNull()
	expect(bad.leadsTo).toEqual(['/ok'])
	expect(bad.problems).toEqual([
		'rename the file to lowercase letters, digits and dashes; it is not mapped until then',
		'`route: cart"]` is not a path',
		'`leads_to` entry `javascript:x` is not a path',
	])
	expect(routeMapMermaid([bad])).toBe('flowchart LR')

	const block = parseFlow('block', flow('route: /a\nleads_to:\n  - /b'))
	expect(block.leadsTo).toEqual([])
	expect(block.problems).toEqual(['write `leads_to` on one line, as `[/a, /b]`'])
	expect(parseFlow('bom', `\uFEFF${flow('route: /a')}`).route).toBe('/a')
})

test('a flow file that is a link is never read, and a dangling one breaks nothing', () => {
	fx = makeFixture()
	fx.write('secret.txt', 'route: /leaked')
	fx.write('.fabrika/architecture/flows/real.flow.md', flow('route: /a'))
	symlinkSync(join(fx.root, 'secret.txt'), join(fx.root, '.fabrika/architecture/flows/leak.flow.md'))
	symlinkSync(join(fx.root, 'missing.md'), join(fx.root, '.fabrika/architecture/flows/gone.flow.md'))
	const flows = readFlows(fx.root)
	expect(flows.map((f) => [f.slug, f.shown, f.problems])).toEqual([
		['gone', false, ['not a regular file (a link or a directory); it is not read']],
		['leak', false, ['not a regular file (a link or a directory); it is not read']],
		['real', true, []],
	])
	const view = renderFlowsReview(flows, new Date(0))
	expect(view).not.toContain('leak.flow.md" />')
	expect([...mappedRoutes(flows)]).toEqual(['/a'])
})

test('the map joins flows on shared screens, and skeleton urls off the map are reported', () => {
	const flows = [
		parseFlow('browse', flow('route: /\nleads_to: [/products/:id]')),
		parseFlow('checkout', flow('route: /cart\nleads_to: [/products/:id, /orders/:id]')),
	]
	expect([...mappedRoutes(flows)].sort()).toEqual(['/', '/cart', '/orders/:id', '/products/:id'])
	expect(routeMapMermaid(flows)).toBe([
		'flowchart LR',
		'  s0["/"]',
		'  s1["/products/:id"]',
		'  s2["/cart"]',
		'  s3["/orders/:id"]',
		'  s0 -->|browse| s1',
		'  s2 -->|checkout| s1',
		'  s2 -->|checkout| s3',
	].join('\n'))
	expect(unmappedUrls(flows, ['/cart?step=2', '/admin', '/admin', '/', '/orders/42', '/cart/', '/orders/42/edit'])).toEqual([
		'/admin',
		'/orders/42/edit',
	])
})

test('the generated flows view compiles, renders the map, and keeps flow text as text', async () => {
	fx = makeFixture()
	fx.write(
		'.fabrika/architecture/flows/checkout.flow.md',
		flow('actor: a "shopper" </Section> {x}\ngoal: `pays` ${globalThis.FABRIKA_FLOWS_INJECTED=1}\nroute: /cart\nleads_to: [/orders/:id]'),
	)
	fx.write('.fabrika/architecture/flows/browse.flow.md', flow('route: /\nleads_to: [/cart]'))
	fx.write('.fabrika/architecture/flows/notes.md', 'not a flow')
	const flows = readFlows(fx.root)
	expect(flows.map((f) => f.slug)).toEqual(['browse', 'checkout'])

	const view = renderFlowsReview(flows, new Date('2026-01-01T00:00:00.000Z'))
	expect(view).toContain('<Markdown file=".fabrika/architecture/flows/checkout.flow.md" />')
	expect(view.trimEnd().endsWith(`<Choice id="verdict" label="Verdict" required options={['Approve', 'Request changes']} />\n</Section>`)).toBe(true)

	for (const options of [{}, { assertReadable: () => {} }]) {
		const compiled = await compileJsx(view, { projectRoot: fx.root, tempDir: fx.root, ...options })
		expect(compiled.ok).toBe(true)
		expect(compiled.ok && compiled.js).toContain('flowchart LR')
	}
	expect('FABRIKA_FLOWS_INJECTED' in globalThis).toBe(false)
})

async function run(args: string[]) {
	const proc = Bun.spawn(['bun', 'run', BIN, ...args], {
		env: { ...process.env, FABRIKA_PORT: '19987', FABRIKA_SESSION_ID: 's_flows_test' },
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
	return { code: await proc.exited, stdout, stderr }
}

test('flows review writes the gate view, and the packets from the skeletons on report a url off the map', async () => {
	fx = makeFixture()
	fx.write('.fabrika/intent/brief.md')
	fx.write('.fabrika/intent/glossary.md')
	fx.write('.fabrika/principles/principles.md')
	const flowsPacket = await run(['next', '--dir', fx.root])
	expect(flowsPacket.stdout).toContain(
		'Gate:    fabrika builder flows review && fabrika builder gate open flows --view .fabrika/architecture/flows-review.jsx',
	)

	fx.write('.fabrika/architecture/flows/checkout.flow.md', flow('route: /cart\nleads_to: [/orders/:id]'))
	fx.write('.fabrika/architecture/flows/browse.flow.md', flow('actor: shopper'))

	const review = await run(['flows', 'review', '--dir', fx.root])
	expect(review.code).toBe(0)
	expect(review.stdout.trim()).toBe(join(fx.root, '.fabrika/architecture/flows-review.jsx'))
	expect(review.stderr).toContain('warning: .fabrika/architecture/flows/browse.flow.md: no `route:` in its front matter')

	fx.write('.fabrika/architecture/tech.md')
	fx.write('tests/browser/admin.test.ts', "browserTest('admin edits', { url: '/admin', seeds: [], roles: [] }, async () => {})\n")
	const skeletons = await run(['next', '--dir', fx.root])
	expect(skeletons.stdout).toContain('## Phase 6/7 - Induce issues')
	expect(skeletons.stdout).toContain("Routes:  warning: skeleton url /admin is on no flow's route map (route or leads_to)")
	const advance = await run(['advance', '--dir', fx.root])
	expect(advance.stderr).toContain("warning: skeleton url /admin is on no flow's route map (route or leads_to)")
})
