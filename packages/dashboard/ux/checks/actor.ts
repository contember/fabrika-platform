import type { Locator, Page } from 'playwright'
import { type Adapter, adapter } from './adapter'

/** How long the network must stay quiet before an action counts as settled. */
const QUIET_MS = 300
const SETTLE_TIMEOUT_MS = 30_000

/** Keystroke-level model operator times in seconds (Kieras, "Using the Keystroke-Level Model"). */
const KLM: Readonly<Record<'keystroke' | 'point' | 'click' | 'home' | 'mental', number>> = {
	keystroke: 0.28,
	point: 1.1,
	click: 0.2,
	home: 0.4,
	mental: 1.2,
}

export interface ActorCounts {
	readonly clicks: number
	readonly fills: number
	readonly keyPresses: number
	readonly typedCharacters: number
	/** State keys in visiting order, the start included. */
	readonly states: readonly string[]
}

/** The state a person perceives: route with query, selected tab, open dialog. Runs in the browser, so it takes the selectors. */
export function stateKey(selectors: Pick<Adapter, 'dialog' | 'dialogTitle' | 'selectedTab'>): string {
	const visible = (element: Element): boolean => {
		const box = element.getBoundingClientRect()
		return box.width > 0 && box.height > 0
	}
	const dialog = Array.from(document.querySelectorAll(selectors.dialog)).filter(visible).at(-1)
	const dialogTitle = dialog === undefined ? null : dialog.querySelector(selectors.dialogTitle)?.textContent?.trim() ?? 'dialog'
	const tab = Array.from(document.querySelectorAll(selectors.selectedTab)).filter(visible).map((element) => element.textContent?.trim() ?? '').join(
		'+',
	)
	return [location.pathname + location.search, tab === '' ? null : `tab:${tab}`, dialogTitle === null ? null : `dialog:${dialogTitle}`]
		.filter((part) => part !== null)
		.join(' | ')
}

/**
 * Performs a task's actions and counts them: every interaction of a reference path goes through it, so the counts are
 * observed, not estimated. It waits for the network itself, because `networkidle` resolves at once after an SPA's load.
 */
export class Actor {
	private clicks = 0
	private fills = 0
	private keyPresses = 0
	private typedCharacters = 0
	private readonly states: string[] = []
	private inFlight = 0
	private lastActivity = Date.now()

	constructor(private readonly page: Page) {
		const started = (): void => {
			this.inFlight += 1
			this.lastActivity = Date.now()
		}
		const ended = (): void => {
			this.inFlight = Math.max(0, this.inFlight - 1)
			this.lastActivity = Date.now()
		}
		page.on('request', started)
		page.on('requestfinished', ended)
		page.on('requestfailed', ended)
	}

	async begin(): Promise<void> {
		await this.recordState()
	}

	async click(target: Locator): Promise<void> {
		await target.click()
		this.clicks += 1
		await this.recordState()
	}

	/** Choosing an option of a native select; not counted when it is already chosen. */
	async select(target: Locator, label: string): Promise<void> {
		const current = await target.evaluate((element) =>
			element instanceof HTMLSelectElement ? element.selectedOptions[0]?.textContent?.trim() ?? '' : ''
		)
		if (current === label) return
		await target.selectOption({ label })
		this.clicks += 1
		await this.recordState()
	}

	/** One field filled, whatever the value's length; the characters feed the KLM estimate. */
	async fill(target: Locator, value: string): Promise<void> {
		await target.fill(value)
		this.fills += 1
		this.typedCharacters += value.length
		await this.recordState()
	}

	async press(target: Locator, key: string): Promise<void> {
		await target.press(key)
		this.keyPresses += 1
		await this.recordState()
	}

	counts(): ActorCounts {
		return { clicks: this.clicks, fills: this.fills, keyPresses: this.keyPresses, typedCharacters: this.typedCharacters, states: [...this.states] }
	}

	/** Point and click per click; home, point, click and type per fill; one mental operator per action. */
	klmSeconds(): number {
		const actions = this.clicks + this.fills + this.keyPresses
		const pointing = (this.clicks + this.fills) * (KLM.point + KLM.click)
		const typing = this.typedCharacters * KLM.keystroke + this.fills * 2 * KLM.home + this.keyPresses * KLM.keystroke
		return Math.round((actions * KLM.mental + pointing + typing) * 10) / 10
	}

	private async settle(): Promise<void> {
		// The action's own request may start after it returns: the quiet period counts from the action, not from before it.
		this.lastActivity = Date.now()
		const deadline = Date.now() + SETTLE_TIMEOUT_MS
		while (Date.now() < deadline) {
			if (this.inFlight === 0 && Date.now() - this.lastActivity >= QUIET_MS) return
			await this.page.waitForTimeout(50)
		}
		throw new Error(`the page did not settle within ${SETTLE_TIMEOUT_MS} ms (${this.inFlight} requests in flight)`)
	}

	private async recordState(): Promise<void> {
		await this.settle()
		const key = await this.page.evaluate(stateKey, { dialog: adapter.dialog, dialogTitle: adapter.dialogTitle, selectedTab: adapter.selectedTab })
		if (this.states.at(-1) !== key) this.states.push(key)
	}
}
