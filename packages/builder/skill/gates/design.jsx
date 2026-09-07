{
	/* Gate: design (phase 5). Pair this review canvas with the live mockup the
    dashboard renders from .fabrika/architecture/design.md tokens. Push BOTH the
    mockup spec and the token table; the right pane shows the themed screen. */
}
<Section title="Phase 5 — Design tokens + mockup">
	<Item id="header" label="Screen: the primary flow surface" badge="h1" badgeVariant="info">
		The key screen from a user flow (heading + the main action).
	</Item>
	<Table
		headers={['Token', 'Role', 'Value']}
		rows={[
			['color.brand', 'primary action, brand', '#6F4E37'],
			['color.surface', 'page + card background', '#FBF7F0'],
			['color.accent', 'prices, badges', '#C8853A'],
			['radius.card', 'cards, inputs, buttons', '12px'],
		]}
	/>
	<Choice id="palette" label="Primary palette?" required options={['As shown (recommended)', 'Darker', 'Lighter / minimal']} />
	<Choice id="layout-ok" label="Screen layout reads well?" required options={['Yes, approve', 'Adjust hierarchy', 'Bigger primary action']} />
	<UserInput id="design-note" label="Token or layout tweaks?" placeholder="e.g. more contrast on the price" multiline />
</Section>
