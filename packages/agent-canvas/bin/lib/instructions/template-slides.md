# Slides template

**When**: the user asks for a deck, a walkthrough to present, or "a few slides" on a topic. A starting point, not a
component: copy it and change the slides.

**Rules**:

- One idea per slide: a title, at most about five short lines or one diagram, table or image.
- Every slide stays on the page, one under another, so the user can annotate any of them and the annotation finds its
  text again. The arrow keys, Page Up/Down and the buttons move from the slide on screen. Put one deck on a page.
- The user's feedback names the slide through the annotated text; there is no per-slide comment box.
- Colours come from CSS variables only (see `theming`).

```jsx
function Slide({ index, total, title, children }) {
	return (
		<section
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
	const deck = React.useRef(null)
	const slideElements =
		() => [...(deck.current?.querySelectorAll('[data-slide]') ?? [])]
	// The slide on screen, not the last one a key chose: the user may have scrolled since.
	const currentSlide = () =>
		Math.max(
			0,
			slideElements().filter((slide) =>
				slide.getBoundingClientRect().top <= window.innerHeight / 3
			).length - 1,
		)
	const go = (step) => {
		const all = slideElements()
		all[Math.max(0, Math.min(all.length - 1, currentSlide() + step))]
			?.scrollIntoView({ behavior: 'smooth', block: 'start' })
	}
	React.useEffect(() => {
		const onKey = (event) => {
			if (
				event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey
				|| event.shiftKey
			) return
			// Typing in a note or a field must not turn the slide.
			const target = event.target
			if (
				target instanceof HTMLElement
				&& (target.isContentEditable || target.closest('input, textarea, select'))
			) return
			const step =
				{ ArrowRight: 1, PageDown: 1, ArrowLeft: -1, PageUp: -1 }[event.key]
			if (step === undefined) return
			event.preventDefault()
			go(step)
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [])
	return (
		<div ref={deck}>
			{slides.map((slide, index) => (
				<Slide key={index} index={index} total={slides.length} title={slide.title}>
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
				<button type="button" style={navButton} onClick={() => go(-1)}>
					Previous
				</button>
				<button type="button" style={navButton} onClick={() => go(1)}>Next</button>
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
