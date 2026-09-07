{
	/* Gate: intake (phase 1). Fill the Items from .fabrika/intent/brief.md, then
    `fabrika builder gate open intake --view brief.jsx`. The reviewer confirms the
    classification + scope before the conversation proceeds. */
}
<Section title="Phase 1 — Intake: confirm the brief">
	<Item id="problem" label="Problem" badge="brief" badgeVariant="info">
		{/* one-paragraph problem statement from brief.md */}
		What we are building and for whom.
	</Item>
	<Item id="success" label="Success criteria" badge="goal" badgeVariant="success">
		The measurable outcomes that mean "done".
	</Item>
	<Item id="nongoals" label="Non-goals" badge="scope" badgeVariant="neutral">
		Explicitly out of scope for v1.
	</Item>
	<Choice id="kind" label="Project shape?" required options={['Web app (recommended)', 'Mobile app', 'API only']} />
	<Choice id="scale" label="Scale?" required options={['Prototype', 'Small SaaS', 'Consumer']} />
	<UserInput id="missed" label="Anything missed or misread?" placeholder="write here…" multiline />
</Section>
