import type { BuildEvent, PhaseState, SessionMeta } from './types'

export const FIXTURE_SESSION_ID = 'fixture-session'

export const FIXTURE_PHASE_STATE: PhaseState = {
	current: 'design',
	index: 4,
	completed: ['intake', 'vision', 'flows', 'tech'],
	reads: [
		'.fabrika/architecture/flows/checkout.flow.md',
		'.fabrika/architecture/flows/browse.flow.md',
		'.fabrika/architecture/tech.md',
	],
	produces: ['.fabrika/architecture/design.md', '.fabrika/pages/*.jsx'],
	gate: true,
	satisfied: false,
}

export const FIXTURE_META: SessionMeta = {
	id: FIXTURE_SESSION_ID,
	currentRevision: 5,
	canvasFiles: [
		{ filename: 'checkout-mockup.jsx', label: 'Checkout mockup' },
		{ filename: 'design-tokens.jsx', label: 'Design tokens' },
	],
	revisions: [
		{ revision: 1, label: 'intake', canvasFiles: [{ filename: 'intake.jsx' }] },
		{ revision: 2, label: 'vision', canvasFiles: [{ filename: 'vision.jsx' }] },
		{ revision: 3, label: 'flows', canvasFiles: [{ filename: 'flows.jsx' }] },
		{ revision: 4, label: 'tech', canvasFiles: [{ filename: 'tech.jsx' }] },
		{
			revision: 5,
			label: 'design',
			canvasFiles: [{ filename: 'checkout-mockup.jsx' }, { filename: 'design-tokens.jsx' }],
		},
	],
	gate: 'design',
	label: 'Design tokens + mockups',
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
		`# Tech\n\nStack: **cf-lightweight** (lopata + oblaka + vite/react).\n\n- Routes via the cf-lightweight stack conventions.\n- Data layer: D1 + seed infra from skeleton metadata.\n- Reasoning: matches the team's deployment target; opice harness wires in cleanly.`,
	design:
		`# Design tokens\n\nSemantic layer → Tailwind/CSS vars.\n\n- \`--surface\` → warm off-black\n- \`--accent\` → roast amber\n- \`--text\` → bone\n\nMockups: \`pages/checkout.jsx\`, \`pages/product.jsx\`. See the live-preview pane → it renders the kernel-compiled JSX with these tokens applied.`,
	skeletons:
		`# Opice skeletons\n\nOne \`*.test.ts\` per flow, each a metadata-first \`browserTest\` with pending \`step{intent,hint}\` stubs and \`invariant.todo\` acceptances. Reviewed as a grid in the workspace.`,
	issues:
		`# Issues (induced)\n\nDeterministic compile step — issues induced from skeleton metadata.\n\n- ISSUE-001 Foundation: routes + seed infra.\n- ISSUE-002 Feature: cart + checkout vertical slice.`,
	build:
		`# Build\n\nPer-issue assisted pipeline. The live-preview pane (right) will host the real running app (localhost:5173) once an issue is in flight.`,
}
