{
	/* Gate: skeletons (phase 5). One row per tests/browser/*.test.ts. Confirm the
    acceptance contract (scenarios + frozen invariants) before issue induction.
    The dashboard also shows the live skeleton grid from /api/session/:id/skeletons. */
}
<Section title="Phase 5 — Opice skeletons (acceptance contract)">
	<Note>
		Each skeleton is the definition of "done" for its flow. The `intent` of every step and every invariant is FROZEN here — the build may write the
		check body but must not weaken the claim.
	</Note>
	<Table
		headers={['Skeleton', 'URL', 'Seeds', 'Steps', 'Invariants']}
		rows={[
			['browse.test.ts', '/', 'catalog', '3', '1'],
			['checkout.test.ts', '/cart', 'catalog, saved-card', '4', '2'],
		]}
	/>
	<Checklist
		items={[
			'Every flow has a skeleton',
			"Each url matches the flow's route (contract)",
			"Invariants capture the durable 'why', not UI details",
		]}
	/>
	<UserInput id="skeletons-note" label="Missing scenarios or invariants?" placeholder="write here…" multiline />
	<Choice id="verdict" label="Verdict" required options={['Approve', 'Request changes']} />
</Section>
