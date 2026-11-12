{
	/* Gate: flows (phase 3). One Item per .fabrika/architecture/flows/*.flow.md.
    Each flow's first segment is its route (a contract the skeletons + build honour). */
}
<Section title="Phase 3 — User flows">
	<Item id="flow-browse" label="Browse — /" badge="flow" badgeVariant="info">
		Land → filter → open an item → act.
	</Item>
	<Item id="flow-checkout" label="Checkout — /cart" badge="flow" badgeVariant="info">
		Review items → provide details → confirm → see the result.
	</Item>
	<UserInput id="flows-note" label="Missing steps or edge cases?" placeholder="write here…" multiline />
	<Choice id="verdict" label="Verdict" required options={['Approve', 'Request changes']} />
</Section>
