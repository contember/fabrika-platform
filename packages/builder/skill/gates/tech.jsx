{
	/* Gate: tech (phase 4). From .fabrika/architecture/tech.md — the stack pointer
    + reasoning. Confirm the stack + data layer before design/skeletons. */
}
<Section title="Phase 4 — Tech & scaffold decision">
	<Item id="stack" label="Stack preset" badge="stack" badgeVariant="info">
		e.g. cf-lightweight; for a Vozka/Propustka internal app use cf-internal-app.
	</Item>
	<Item id="data" label="Data layer" badge="data" badgeVariant="neutral">
		Where state lives and how it is seeded for tests.
	</Item>
	<Item id="reasoning" label="Reasoning" badge="why" badgeVariant="neutral">
		Why this stack fits the deployment target + the team.
	</Item>
	<Choice id="tech-ok" label="Stack approved?" required options={['Yes, proceed', 'Different stack', 'Revisit data layer']} />
	<UserInput id="tech-note" label="Constraints to capture?" placeholder="write here…" multiline />
</Section>
