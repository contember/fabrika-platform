{
	/* Gate: tech (phase 4). From .fabrika/architecture/tech.md — the stack pointer
    + reasoning. Confirm the stack + data layer before design/skeletons. */
}
<Section title="Phase 4 — Tech & scaffold decision">
	<Item id="stack" label="Stack preset" badge="stack" badgeVariant="info">
		zerops-app (the default), or cf-app for an installation on Cloudflare. Every other preset is unsupported.
	</Item>
	<Item id="data" label="Data layer" badge="data" badgeVariant="neutral">
		Where state lives and how it is seeded for tests.
	</Item>
	<Item id="reasoning" label="Reasoning" badge="why" badgeVariant="neutral">
		Why this stack fits the deployment target + the team.
	</Item>
	<UserInput id="tech-note" label="Constraints to capture?" placeholder="write here…" multiline />
	<Choice id="verdict" label="Verdict" required options={['Approve', 'Request changes']} />
</Section>
