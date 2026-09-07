{
	/* Gate: vision (phase 2). From .fabrika/intent/glossary.md +
    .fabrika/principles/principles.md. Confirm the ubiquitous language and the
    Must/Must-not/Preference principles before flows. */
}
<Section title="Phase 2 — Vision, scope & principles">
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
	<Choice id="principles-ok" label="Principles + glossary agreed?" required options={['Yes, proceed', 'Edit a term', 'Add a principle']} />
	<UserInput id="vision-note" label="Edits to scope or wording?" placeholder="write here…" multiline />
</Section>
