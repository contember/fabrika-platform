import AxeBuilder from '@axe-core/playwright'
import type { Page } from 'playwright'
import { type Adapter, adapter } from './adapter'
import type { LabelKind, PageElement, PageSpec } from './types'

export interface LabelHit {
	readonly text: string
	readonly aboveFold: boolean
}

export interface LayoutMetrics {
	readonly viewport: string
	/** Page height in viewport heights. */
	readonly screens: number
	readonly interactive: number
	readonly interactiveAboveFold: number
	readonly buttons: number
	readonly sections: number
	/** Visible text leaves in the content column above the fold. */
	readonly textAboveFold: number
	readonly fields: number
	/** Areas holding more than one filled button, by area label. */
	readonly areasWithSeveralPrimary: readonly string[]
	readonly leadFacts: number
	readonly labels: Readonly<Record<LabelKind, readonly LabelHit[]>>
	/** Content text that looks technical: UUIDs, long hex, snake_case, JSON. Candidates for the element map only. */
	readonly technicalCandidates: readonly string[]
}

/** Runs in the browser; takes the adapter as an argument. */
function measureLayout(selectors: Adapter): LayoutMetrics {
	const fold = window.innerHeight
	const visible = (element: Element): boolean => {
		const box = element.getBoundingClientRect()
		return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden'
	}
	const top = (element: Element): number => element.getBoundingClientRect().top + window.scrollY
	const all = (selector: string, root: ParentNode = document): Element[] => Array.from(root.querySelectorAll(selector)).filter(visible)
	const textOf = (element: Element): string => (element.textContent ?? '').replace(/\s+/g, ' ').trim()
	const main = document.querySelector(selectors.main)
	const interactive = all('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=checkbox]')
	const hits = (selector: string, fromAttribute: boolean): LabelHit[] =>
		all(selector).map((element) => ({
			text: fromAttribute ? element.getAttribute('aria-label') ?? '' : textOf(element),
			aboveFold: top(element) < fold,
		}))
	const primaryByArea = new Map<Element, number>()
	for (const button of all(selectors.primaryButton)) {
		const area = button.closest(selectors.actionArea)
		if (area !== null) primaryByArea.set(area, (primaryByArea.get(area) ?? 0) + 1)
	}
	const areaLabel = (area: Element): string => textOf(area.querySelector('h1, h2') ?? area).slice(0, 60)
	const lead = document.querySelector(selectors.lead)
	const leaves = main === null ? [] : all('*', main).filter((element) => element.children.length === 0 && textOf(element) !== '')
	const technical = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{16,}\b|\b[a-z]+_[a-z_]+\b|^[[{]/
	return {
		viewport: `${window.innerWidth}x${fold}`,
		screens: Math.round((document.documentElement.scrollHeight / fold) * 10) / 10,
		interactive: interactive.length,
		interactiveAboveFold: interactive.filter((element) => top(element) < fold).length,
		buttons: all(selectors.button).length,
		sections: all(selectors.labels.section).length,
		textAboveFold: leaves.filter((element) => top(element) < fold).length,
		fields: main === null ? 0 : all(selectors.field, main).length,
		areasWithSeveralPrimary: [...primaryByArea.entries()].filter(([, count]) => count > 1).map(([area]) => areaLabel(area)),
		leadFacts: lead === null ? 0 : lead.children.length,
		labels: {
			section: hits(selectors.labels.section, false),
			column: hits(selectors.labels.column, false),
			tab: hits(selectors.labels.tab, false),
			action: hits(selectors.labels.action, false),
			region: hits(selectors.labels.region, true),
		},
		technicalCandidates: [...new Set(leaves.map(textOf).filter((text) => technical.test(text)))].slice(0, 30),
	}
}

export interface InventoryViolation {
	readonly element: string
	readonly label: string
	readonly reason: string
}

const hitsFor = (element: PageElement, metrics: LayoutMetrics): readonly LabelHit[] =>
	metrics.labels[element.kind].filter((hit) => hit.text === element.label)

/**
 * The inventory gate: an element mapped technical or remove must not show on the default view; a primary element must
 * show above the fold. An element the page does not render is skipped unless it is primary.
 */
export function inventoryViolations(spec: PageSpec, metrics: LayoutMetrics): InventoryViolation[] {
	const violations: InventoryViolation[] = []
	for (const element of spec.elements) {
		const hits = hitsFor(element, metrics)
		if (hits.length === 0) {
			if (element.placement === 'primary') {
				violations.push({ element: element.id, label: element.label, reason: 'primary element not on the default view' })
			}
			continue
		}
		if (element.placement === 'technical' || element.placement === 'remove') {
			violations.push({ element: element.id, label: element.label, reason: `${element.placement} element on the default view` })
		} else if (element.placement === 'primary' && !hits.some((hit) => hit.aboveFold)) {
			violations.push({ element: element.id, label: element.label, reason: 'primary element below the fold' })
		}
	}
	return violations
}

/** Map elements the default view does not show: hidden as approved, or renamed and the map is stale. */
export const unmatchedElements = (spec: PageSpec, metrics: LayoutMetrics): readonly string[] =>
	spec.elements.filter((element) => hitsFor(element, metrics).length === 0).map((element) => element.label)

export interface AxeSummary {
	readonly serious: number
	readonly critical: number
	readonly rules: readonly string[]
}

export async function axeSummary(page: Page): Promise<AxeSummary> {
	const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
	const severe = result.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
	return {
		serious: severe.filter((violation) => violation.impact === 'serious').length,
		critical: severe.filter((violation) => violation.impact === 'critical').length,
		rules: severe.map((violation) =>
			`${violation.id} (${violation.nodes.length}: ${violation.nodes.slice(0, 3).map((node) => node.target.join(' ')).join(', ')})`
		),
	}
}

export const measurePage = (page: Page): Promise<LayoutMetrics> => page.evaluate(measureLayout, adapter)
