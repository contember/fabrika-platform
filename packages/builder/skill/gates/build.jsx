{
	/* Gate: build (phase 8). A per-issue / final-review canvas. The dashboard build
    pane streams live BuildEvents from /api/build/stream alongside this. Use it to
    sign off green issues and triage blocked ones at final review. */
}
<Section title="Phase 8 — Build review">
	<Table
		headers={['Issue', 'Satisfies', 'Status']}
		rows={[
			['ISSUE-001', 'scaffold + routes', '✓ green'],
			['ISSUE-101', 'browse scenario', '✓ green'],
			['ISSUE-102', 'checkout scenario', '⚠ blocked'],
		]}
	/>
	<Item id="blocked" label="Blocked issues need a decision" badge="triage" badgeVariant="warning">
		For each blocked issue: relax the approach, split it, or accept the gap.
	</Item>
	<UserInput id="build-note" label="Notes for the blocked issues?" placeholder="write here…" multiline />
	<Choice id="verdict" label="Verdict" required options={['Approve', 'Request changes']} />
</Section>
