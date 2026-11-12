{
	/* Gate: design-checkpoint (ISSUE-004, inside the build). The app already runs on the
    paved-road kit; this gate reviews its theme on the real screens, not a mockup. List the
    --fui-* overrides from the SPA's stylesheet, and the routes the reviewer should open in the
    live preview (publish it first with `fabrika builder preview --url=…`). */
}
<Section title="Design — theme of the running app">
	<Note>Open each route in the preview pane. The values below are the overrides in the SPA stylesheet, imported after @fabrika/ui/styles.css.</Note>
	<Table
		headers={['Token', 'Role', 'Value']}
		rows={[
			['--fui-accent', 'primary action', '#6F4E37'],
			['--fui-surface', 'cards and panels', '#FBF7F0'],
			['--fui-radius-md', 'cards, inputs, buttons', '12px'],
		]}
	/>
	<Table
		headers={['Route', 'Screen', 'Flow']}
		rows={[
			['/', 'catalog', 'browse'],
			['/cart', 'cart and checkout', 'checkout'],
		]}
	/>
	<Choice id="palette" label="Palette?" required options={['As shown', 'More contrast', 'Calmer']} />
	<UserInput id="design-note" label="Which screen or token should change?" placeholder="e.g. the price is hard to read on /cart" multiline />
	<Choice id="verdict" label="Verdict" required options={['Approve', 'Request changes']} />
</Section>
