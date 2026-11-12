# Slides template

**When**: the user asks for a deck, a walkthrough to present, or "a few slides" on a topic. A starting point, not a
component: copy it and change the slides.

**Rules**:

- One idea per slide: a title, at most about five short lines or one diagram, table or image.
- Every slide stays on the page, one under another, so the user can annotate any of them and the annotation finds its
  text again. The arrow keys and the buttons move between slides.
- The user's feedback names the slide through the annotated text; there is no per-slide comment box.
- Colours come from CSS variables only (see `theming`).

```jsx
function Slide({ index, total, title, children }) {
	return (
		<section
			id={`slide-${index}`}
			data-slide={index}
			style={{
				aspectRatio: '16 / 9',
				background: 'var(--color-bg-surface)',
				border: '1px solid var(--color-border-subtle)',
				borderRadius: 12,
				padding: '40px 48px',
				margin: '0 0 24px',
				display: 'flex',
				flexDirection: 'column',
				gap: 16,
				scrollMarginTop: 24,
			}}
		>
			<h2
				style={{
					fontFamily: 'var(--font-heading)',
					fontSize: '2rem',
					margin: 0,
					color: 'var(--color-text-primary)',
				}}
			>
				{title}
			</h2>
			<div
				style={{
					flex: 1,
					color: 'var(--color-text-primary)',
					fontSize: '1.0625rem',
					lineHeight: 1.6,
				}}
			>
				{children}
			</div>
			<div
				style={{
					alignSelf: 'flex-end',
					color: 'var(--color-text-tertiary)',
					fontSize: '0.75rem',
				}}
			>
				{index + 1} / {total}
			</div>
		</section>
	)
}

const navButton = {
	background: 'var(--color-bg-elevated)',
	color: 'var(--color-text-primary)',
	border: '1px solid var(--color-border-medium)',
	borderRadius: 6,
	padding: '6px 14px',
	fontFamily: 'var(--font-body)',
	fontSize: '0.8125rem',
}

function Deck({ slides }) {
	const [current, setCurrent] = React.useState(0)
	const go = (next) => {
		const index = Math.max(0, Math.min(slides.length - 1, next))
		setCurrent(index)
		document.getElementById(`slide-${index}`)?.scrollIntoView({
			behavior: 'smooth',
			block: 'start',
		})
	}
	React.useEffect(() => {
		const onKey = (event) => {
			// Typing in a note or a field must not turn the slide.
			if (
				event.target instanceof HTMLElement
				&& event.target.closest('input, textarea, [contenteditable="true"]')
			) return
			if (event.key === 'ArrowRight' || event.key === 'PageDown') go(current + 1)
			if (event.key === 'ArrowLeft' || event.key === 'PageUp') go(current - 1)
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	})
	return (
		<div>
			{slides.map((slide, index) => (
				<Slide
					key={slide.title}
					index={index}
					total={slides.length}
					title={slide.title}
				>
					{slide.body}
				</Slide>
			))}
			<div
				style={{
					position: 'sticky',
					bottom: 16,
					display: 'flex',
					justifyContent: 'center',
					gap: 8,
				}}
			>
				<button
					type="button"
					style={navButton}
					onClick={() => go(current - 1)}
					disabled={current === 0}
				>
					Previous
				</button>
				<button
					type="button"
					style={navButton}
					onClick={() => go(current + 1)}
					disabled={current === slides.length - 1}
				>
					Next
				</button>
			</div>
		</div>
	)
}

export default function Canvas() {
	return (
		<Deck
			slides={[
				{
					title: 'Moving checkout to the new cache',
					body: <p>What changed, what it bought us, and what is left.</p>,
				},
				{
					title: 'Why',
					body: (
						<ul>
							<li>P95 checkout latency was over 300 ms at peak.</li>
							<li>Most of it was repeated cart and price lookups.</li>
						</ul>
					),
				},
				{
					title: 'How it works',
					body: (
						<Mermaid>
							{`
							graph LR
								A[Checkout] --> B{Cache}
								B -->|hit| C[Response]
								B -->|miss| D[Pricing service] --> B
						`}
						</Mermaid>
					),
				},
				{
					title: 'Result',
					body: (
						<Table
							headers={['', 'Before', 'After']}
							rows={[['P95', '320 ms', '190 ms'], ['Errors', '0.5%', '0.4%']]}
						/>
					),
				},
				{
					title: 'Next',
					body: <p>Route shipping options through the cache; it did not improve.</p>,
				},
			]}
		/>
	)
}
```

Read `component-custom` for the module format and `theming` for the variables. A project can set its own colours
and fonts in `.agent-canvas/theme.css` (see `theming`).
