// The exact layer of the console's UX review (ux/README.md): page checks and task reference paths against the local stack.
//   bun ux/checks/run.ts [--base=<origin>] [--only=<id>,...] [--out=<dir>] [--writes] [--update-baseline]
//   bun ux/checks/run.ts tasks | snippet    (the task cards a reviewer reads · the state-key snippet for agent-browser)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright'
import { z } from 'zod'
import { pages } from '../pages'
import { tasks } from '../tasks'
import { Actor, type ActorCounts, stateKey } from './actor'
import { adapter } from './adapter'
import {
	type AxeSummary,
	axeSummary,
	type InventoryViolation,
	inventoryViolations,
	type LayoutMetrics,
	measurePage,
	unmatchedElements,
} from './page-checks'
import type { PageSpec, TaskBudget, UxTask } from './types'

const VIEWPORT = { width: 1440, height: 900 }
const UX_DIR = import.meta.dir
const BASELINE_PATH = join(UX_DIR, '..', 'baseline.json')
/** A reference path may grow by this share over the baseline before the gate fails. */
const BASELINE_TOLERANCE = 0.2
const BUDGET_KEYS: readonly (keyof TaskBudget)[] = ['clicks', 'fills', 'keyPresses', 'states']
const DEFAULT_BASE = 'http://control.fabrika.localhost:18080'

interface Options {
	readonly base: string
	readonly only: ReadonlySet<string> | null
	readonly out: string
	readonly writes: boolean
	readonly updateBaseline: boolean
}

type PageResult =
	| {
		readonly id: string
		readonly error: null
		readonly metrics: LayoutMetrics
		readonly inventory: readonly InventoryViolation[]
		readonly unmatched: readonly string[]
		readonly axe: AxeSummary
	}
	| { readonly id: string; readonly error: string }

interface TaskResult {
	readonly id: string
	readonly persona: string
	readonly kind: UxTask['kind']
	readonly error: string | null
	readonly counts: ActorCounts
	readonly observed: TaskBudget
	readonly klmSeconds: number
	readonly overBudget: readonly string[]
	readonly overBaseline: readonly string[]
}

const budgetSchema = z.object({ clicks: z.number().int(), fills: z.number().int(), keyPresses: z.number().int(), states: z.number().int() })
const baselineSchema = z.object({ revision: z.string(), viewport: z.string(), tasks: z.record(budgetSchema) })
type Baseline = z.infer<typeof baselineSchema>

/** The tasks sign in through the local development login and some write data, so only a local origin is accepted. */
function parseBase(raw: string): string {
	const url = URL.parse(raw)
	const local = url !== null && (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname === '127.0.0.1')
	if (url === null || url.protocol !== 'http:' || !local) throw new Error(`--base must be a local http origin (*.localhost or 127.0.0.1), got ${raw}`)
	return url.origin
}

function parseOptions(args: readonly string[]): Options {
	const value = (name: string): string | undefined => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
	const only = value('only')
	return {
		base: parseBase(value('base') ?? DEFAULT_BASE),
		only: only === undefined ? null : new Set(only.split(',')),
		out: value('out') ?? join(UX_DIR, '..', 'runs', new Date().toISOString().replace(/[:.]/g, '-')),
		writes: args.includes('--writes'),
		updateBaseline: args.includes('--update-baseline'),
	}
}

function revision(): string {
	const head = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: UX_DIR }).stdout.toString().trim()
	const dirty = Bun.spawnSync(['git', 'status', '--porcelain', '--', '..'], { cwd: join(UX_DIR, '..') }).stdout.toString().trim() !== ''
	return `${head}${dirty ? '+dirty' : ''}`
}

function readBaseline(): Baseline | null {
	if (!existsSync(BASELINE_PATH)) return null
	return baselineSchema.parse(JSON.parse(readFileSync(BASELINE_PATH, 'utf8')))
}

/** The local stack signs a browser in through its development login: opening the console follows the redirects. */
async function signIn(browser: Browser, base: string): Promise<BrowserContext> {
	const context = await browser.newContext({ viewport: VIEWPORT, locale: 'en-US' })
	const page = await context.newPage()
	await page.goto(`${base}/`)
	await page.waitForURL((url) => url.origin === base, { timeout: 15_000 })
	await page.locator('.workspace').waitFor({ timeout: 15_000 })
	await page.close()
	return context
}

async function openRoute(page: Page, base: string, path: string): Promise<void> {
	await page.goto(`${base}${path}`)
	await page.locator('.workspace').waitFor({ timeout: 15_000 })
	await page.waitForLoadState('networkidle')
}

const firstLine = (thrown: unknown): string => thrown instanceof Error ? thrown.message.split('\n')[0] ?? thrown.message : String(thrown)

async function checkPage(context: BrowserContext, options: Options, spec: PageSpec): Promise<PageResult> {
	const page = await context.newPage()
	try {
		await openRoute(page, options.base, spec.path)
		// The environment lamps load after the page; measure the settled view.
		await page.waitForFunction(() => !document.body.textContent?.includes('Reading…'), undefined, { timeout: 30_000 })
		const metrics = await measurePage(page)
		await page.screenshot({ path: join(options.out, `${spec.id}.png`), fullPage: true })
		const axe = await axeSummary(page)
		return { id: spec.id, error: null, metrics, inventory: inventoryViolations(spec, metrics), unmatched: unmatchedElements(spec, metrics), axe }
	} catch (thrown) {
		// One unreachable page fails its own gate; the other pages and the tasks still report.
		await page.screenshot({ path: join(options.out, `${spec.id}-failed.png`), fullPage: true }).catch(() => undefined)
		return { id: spec.id, error: firstLine(thrown) }
	} finally {
		await page.close()
	}
}

function overLimits(observed: TaskBudget, limits: TaskBudget, slack: number): string[] {
	return BUDGET_KEYS.filter((key) => observed[key] > Math.floor(limits[key] * (1 + slack))).map((key) => `${key} ${observed[key]} > ${limits[key]}`)
}

async function runTask(context: BrowserContext, options: Options, task: UxTask, baseline: Baseline | null): Promise<TaskResult> {
	const page = await context.newPage()
	let error: string | null = null
	const actor = new Actor(page)
	try {
		await openRoute(page, options.base, task.start)
		await actor.begin()
		await task.run(page, actor)
	} catch (thrown) {
		error = firstLine(thrown)
		await page.screenshot({ path: join(options.out, `${task.id}-failed.png`), fullPage: true }).catch(() => undefined)
	}
	await page.close()
	const counts = actor.counts()
	const observed = { clicks: counts.clicks, fills: counts.fills, keyPresses: counts.keyPresses, states: new Set(counts.states).size }
	const reference = baseline?.tasks[task.id]
	return {
		id: task.id,
		persona: task.persona,
		kind: task.kind,
		error,
		counts,
		observed,
		klmSeconds: actor.klmSeconds(),
		overBudget: error === null && task.budget !== null ? overLimits(observed, task.budget, 0) : [],
		overBaseline: error === null && reference !== undefined ? overLimits(observed, reference, BASELINE_TOLERANCE) : [],
	}
}

function formatTask(result: TaskResult, budget: TaskBudget | null): string {
	const { observed } = result
	const verdict = result.error !== null
		? `FAIL ${result.error}`
		: result.overBudget.length > 0 || result.overBaseline.length > 0
		? `OVER ${[...result.overBudget, ...result.overBaseline.map((entry) => `baseline: ${entry}`)].join(', ')}`
		: budget === null
		? 'ok (no budget yet: measured)'
		: 'ok'
	return `  ${
		result.id.padEnd(32)
	} clicks ${observed.clicks}  fills ${observed.fills}  keys ${observed.keyPresses}  states ${observed.states}  KLM ${result.klmSeconds}s  ${verdict}`
}

function formatPage(result: PageResult): string[] {
	if (result.error !== null) return [`  ${result.id}: FAIL ${result.error}`]
	const m = result.metrics
	const lines = [
		`  ${result.id}: ${m.screens} screens, ${m.sections} sections, ${m.interactive} interactive (${m.interactiveAboveFold} above fold), ${m.buttons} buttons, ${m.fields} fields, ${m.textAboveFold} text leaves above fold, lead facts ${m.leadFacts}`,
		`    axe serious ${result.axe.serious}, critical ${result.axe.critical}${result.axe.rules.length === 0 ? '' : `: ${result.axe.rules.join(', ')}`}`,
	]
	if (m.areasWithSeveralPrimary.length > 0) lines.push(`    several filled buttons in: ${m.areasWithSeveralPrimary.join('; ')}`)
	for (const violation of result.inventory) lines.push(`    inventory: ${violation.label} (${violation.element}): ${violation.reason}`)
	if (m.technicalCandidates.length > 0) lines.push(`    technical-looking text (advisory): ${m.technicalCandidates.slice(0, 8).join(' | ')}`)
	if (result.unmatched.length > 0) lines.push(`    map elements not on the default view (advisory): ${result.unmatched.join(', ')}`)
	return lines
}

const pageFails = (result: PageResult): boolean =>
	result.error !== null || result.inventory.length > 0 || result.axe.critical > 0 || result.axe.serious > 0
	|| result.metrics.areasWithSeveralPrimary.length > 0

async function main(): Promise<number> {
	const args = Bun.argv.slice(2)
	if (args[0] === 'snippet') {
		const selectors = { dialog: adapter.dialog, dialogTitle: adapter.dialogTitle, selectedTab: adapter.selectedTab }
		console.log(`(${stateKey.toString()})(${JSON.stringify(selectors)})`)
		return 0
	}
	if (args[0] === 'tasks') {
		// A reviewer walks a task without knowing its reference path, so the card leaves `run` out.
		const cards = tasks.map(({ id, persona, kind, goal, success, start, budget, mutates }) => ({
			id,
			persona,
			kind,
			goal,
			success,
			start,
			budget,
			mutates,
		}))
		console.log(JSON.stringify(cards, null, 2))
		return 0
	}
	const options = parseOptions(args)
	mkdirSync(options.out, { recursive: true })
	const baseline = readBaseline()
	const browser = await chromium.launch()
	try {
		const context = await signIn(browser, options.base)
		const known = new Set([...pages.map((spec) => spec.id), ...tasks.map((task) => task.id)])
		const unknown = [...options.only ?? []].filter((id) => !known.has(id))
		if (unknown.length > 0) throw new Error(`--only names no page or task: ${unknown.join(', ')}`)
		const selectedPages = pages.filter((spec) => options.only === null || options.only.has(spec.id))
		const chosenTasks = tasks.filter((task) => options.only === null || options.only.has(task.id))
		const selectedTasks = chosenTasks.filter((task) => options.writes || !task.mutates)
		const skipped = chosenTasks.filter((task) => !selectedTasks.includes(task)).map((task) => task.id)
		const pageResults: PageResult[] = []
		for (const spec of selectedPages) pageResults.push(await checkPage(context, options, spec))
		const taskResults: TaskResult[] = []
		for (const task of selectedTasks) taskResults.push(await runTask(context, options, task, baseline))
		await context.close()

		const report = {
			revision: revision(),
			viewport: `${VIEWPORT.width}x${VIEWPORT.height}`,
			base: options.base,
			pages: pageResults,
			tasks: taskResults,
		}
		writeFileSync(join(options.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
		console.info(`UX checks at ${report.revision}, ${report.viewport}; report in ${options.out}`)
		console.info('Pages:')
		for (const result of pageResults) for (const line of formatPage(result)) console.info(line)
		console.info('Tasks:')
		for (const result of taskResults) console.info(formatTask(result, selectedTasks.find((task) => task.id === result.id)?.budget ?? null))
		if (skipped.length > 0) console.info(`  skipped, they write data (pass --writes on a freshly seeded stack): ${skipped.join(', ')}`)

		const failed = [
			...pageResults.filter(pageFails).map((result) => `page ${result.id}`),
			...taskResults.filter((result) => result.error !== null || result.overBudget.length > 0 || result.overBaseline.length > 0).map((result) =>
				`task ${result.id}`
			),
		]
		if (options.updateBaseline) {
			// The baseline accepts a path only within the approved budget; a path over it stays a failure.
			const accepted = taskResults.filter((result) => result.error === null && result.overBudget.length === 0).map((
				result,
			) => [result.id, result.observed])
			const tasksBaseline = { ...baseline?.tasks, ...Object.fromEntries(accepted) }
			writeFileSync(BASELINE_PATH, `${JSON.stringify({ revision: report.revision, viewport: report.viewport, tasks: tasksBaseline }, null, '\t')}\n`)
			console.info(`Baseline updated: ${BASELINE_PATH}`)
		}
		console.info(failed.length === 0 ? 'Gates: pass' : `Gates: FAIL (${failed.join(', ')})`)
		return failed.length === 0 ? 0 : 1
	} finally {
		await browser.close()
	}
}

process.exit(await main())
