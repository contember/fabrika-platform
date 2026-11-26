import type { LabelKind } from './types'

/** How the checks recognise the console's design system (`src/styles.css`); a check without its selector reports nothing. */
export interface Adapter {
	/** The page's content column, beside the navigation rail. */
	readonly main: string
	readonly primaryButton: string
	readonly button: string
	/** Areas that may hold one filled button each: the page, an open dialog. The nearest one counts. */
	readonly actionArea: string
	readonly dialog: string
	readonly dialogTitle: string
	readonly selectedTab: string
	/** The line of facts under the page title. */
	readonly lead: string
	readonly labels: Readonly<Record<LabelKind, string>>
	readonly field: string
}

export const adapter: Adapter = {
	main: '.workspace',
	primaryButton: 'button.primary, .btn.primary',
	button: 'button, .btn',
	actionArea: '[role=dialog], .workspace',
	dialog: '[role=dialog]',
	dialogTitle: '.modal-head h2',
	selectedTab: '.page-tabs [aria-current=page]',
	lead: '.page-head .subtitle',
	labels: {
		section: '.workspace h2',
		column: '.workspace th',
		tab: '.page-tabs a',
		action: '.workspace button, .workspace .btn',
		region: '.workspace [aria-label]:not(button, a)',
	},
	field: 'input:not([type=hidden]), select, textarea',
}
