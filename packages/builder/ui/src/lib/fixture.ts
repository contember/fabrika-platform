import type { BuildEvent, PhaseState, SessionMeta } from './types'

export const FIXTURE_SESSION_ID = 'fixture-session'

export const FIXTURE_PHASE_STATE: PhaseState = {
	current: 'skeletons',
	index: 4,
	completed: ['intake', 'vision', 'flows', 'tech'],
	reads: ['.fabrika/architecture/flows/checkout.flow.md', '.fabrika/architecture/flows/browse.flow.md'],
	produces: ['tests/browser/*.test.ts'],
	gate: true,
	satisfied: false,
}

export const FIXTURE_META: SessionMeta = {
	id: FIXTURE_SESSION_ID,
	currentRevision: 5,
	canvasFiles: [{ filename: 'review-grid.jsx', label: 'Skeleton review' }],
	revisions: [
		{ revision: 1, label: 'intake', canvasFiles: [{ filename: 'intake.jsx' }] },
		{ revision: 2, label: 'vision', canvasFiles: [{ filename: 'vision.jsx' }] },
		{ revision: 3, label: 'flows', canvasFiles: [{ filename: 'flows.jsx' }] },
		{ revision: 4, label: 'tech', canvasFiles: [{ filename: 'tech.jsx' }] },
		{ revision: 5, label: 'skeletons', canvasFiles: [{ filename: 'review-grid.jsx' }] },
	],
	gate: 'skeletons',
	label: 'Opice skeletons',
}

export const FIXTURE_BUILD_EVENTS: BuildEvent[] = [
	{ status: 'info', message: 'Build events stream here once `fabrika builder build` runs.' },
]

export const FIXTURE_ARTIFACTS: Record<string, string> = {
	intake:
		`# Brief\n\nA local-first storefront for a small roastery. Sells whole-bean coffee, supports a cart and checkout, and a lightweight admin to manage the catalog.\n\n## Users\n- Shopper — browses, adds to cart, checks out.\n- Owner — manages products and reviews orders.\n\n## Success\n- A shopper can complete a purchase end-to-end.\n- The owner can add a product without touching code.\n\n## Non-goals\n- No multi-tenant. No payment provider integration in v1 (mock checkout).`,
	vision:
		`# Glossary\n\n- **Product** — a single SKU with a price and inventory count.\n- **Cart** — the shopper's pending selection, persisted locally.\n- **Order** — a submitted cart, immutable once placed.\n\n# Principles\n\n- MUST keep the catalog readable without an account.\n- MUST persist the cart across reloads.\n- MUST NOT block checkout on network for the mock flow.\n- PREFERENCE: optimistic UI on add-to-cart.`,
	flows:
		`# Flow: checkout\n\n1. Shopper opens \`/cart\`.\n2. Reviews line items, adjusts quantities.\n3. Submits → \`/order/confirmation\`.\n\n# Flow: browse\n\n1. Shopper lands on \`/\`.\n2. Filters by roast level.\n3. Opens a product → adds to cart.`,
	tech:
		`# Tech\n\nStack: **zerops-app** (Bun + PostgreSQL + React/Buzola, Fabrika IAM behind the proxy).\n\n- Routes: the contract's mounts and the SPA.\n- Data layer: @fabrika/db over PostgreSQL + named SQL fixtures from skeleton metadata.\n- Reasoning: the paved road the installation deploys.`,
	skeletons:
		`# Opice skeletons\n\nOne \`*.test.ts\` per flow, each a metadata-first \`browserTest\` with pending \`step{intent,hint}\` stubs and \`invariant.todo\` acceptances. Reviewed as a grid in the workspace.`,
	issues:
		`# Issues (induced)\n\nDeterministic compile step — issues induced from skeleton metadata.\n\n- ISSUE-001 Foundation: routes + seed infra.\n- ISSUE-004 Design checkpoint: theme the running app, reviewed at the design gate.\n- ISSUE-005 Feature: cart + checkout vertical slice.`,
	build:
		`# Build\n\nPer-issue assisted pipeline. The live-preview pane (right) will host the real running app (localhost:5173) once an issue is in flight.`,
}
