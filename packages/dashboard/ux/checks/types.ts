import type { Page } from 'playwright'
import type { Actor } from './actor'

/** Ceilings for a task's reference path; exceeding one fails the gate. */
export interface TaskBudget {
	readonly clicks: number
	readonly fills: number
	readonly keyPresses: number
	/** Distinct UI states visited: route, selected tab, open dialog (`stateKey`). */
	readonly states: number
}

export interface UxTask {
	readonly id: string
	readonly persona: string
	readonly kind: 'main' | 'secondary'
	/** What the persona is told. */
	readonly goal: string
	/** How a reviewer recognises success. */
	readonly success: string
	/** The console route where the task starts. */
	readonly start: string
	/** The first measured reference path, or what a person approves; null for a new task until a run measures it. */
	readonly budget: TaskBudget | null
	/** The reference path writes data; it runs only with `--writes` on a freshly seeded stack. */
	readonly mutates: boolean
	/** The reference path: the shortest known way to finish, ending with assertions of success. */
	readonly run: (page: Page, actor: Actor) => Promise<void>
}

/** Where an element belongs by the triage rubric (README.md). */
export type Placement = 'primary' | 'secondary' | 'disclosed' | 'technical' | 'remove'

export type LabelKind = 'section' | 'column' | 'tab' | 'action' | 'region'

export interface PageElement {
	readonly id: string
	/** The visible label that locates the element: a section heading, a column header, a tab, a button. */
	readonly label: string
	readonly kind: LabelKind
	/** Tasks that read or operate the element: a reviewed map, not inferred from the reference paths. */
	readonly usedBy: readonly string[]
	/** 2 = blocks or hides a warning, 1 = slows down, 0 = nothing happens when the user does not see it. */
	readonly consequence: 0 | 1 | 2
	readonly audience: 'all' | 'role' | 'technical'
	readonly placement: Placement
}

export interface PageSpec {
	readonly id: string
	/** The console route of the page's default view. */
	readonly path: string
	readonly elements: readonly PageElement[]
}
