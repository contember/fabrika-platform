{
	/* Gate: vision (phase 2), the one review of the intent. Fill it from
    .fabrika/intent/brief.md (phase 1, which has no gate of its own),
    .fabrika/intent/glossary.md and .fabrika/principles/principles.md, then
    `fabrika builder gate open vision --view brief.jsx`. The reviewer confirms
    the problem, scope, language and principles in one pass before flows. */
}
<Section title="Brief, vision and principles">
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
	<Item id="vision" label="Vision" badge="vision" badgeVariant="info">
		The one-line product vision.
	</Item>
	<Table
		headers={['Term', 'Means exactly']}
		rows={[
			['Term A', 'single agreed meaning'],
			['Term B', 'single agreed meaning'],
		]}
	/>
	<Note>Principles use RFC-2119 keywords: MUST / MUST NOT / SHOULD / MAY.</Note>
	<Checklist
		items={[
			'MUST: a hard requirement',
			'MUST NOT: a hard prohibition',
			'PREFERENCE: a tie-breaker',
		]}
	/>
	<Choice id="kind" label="Project shape?" required options={['Web app (recommended)', 'Mobile app', 'API only']} />
	<Choice id="scale" label="Scale?" required options={['Prototype', 'Small SaaS', 'Consumer']} />
	<UserInput id="missed" label="Anything missed, misread or worded wrong?" placeholder="write here…" multiline />
	<Choice id="verdict" label="Verdict" required options={['Approve', 'Request changes']} />
</Section>
