# Dashboard template

**When**: the user wants numbers at a glance: a status report, metrics after a change, a comparison of runs, a
summary of a log or a CSV. A starting point, not a component: copy it and change what it shows.

**Rules**:

- Put the 3–5 numbers that answer the user's question first, as tiles. Everything else goes below.
- Show where each number comes from (a file, a command, a time range) in the tile's note or a `Note`.
- Use `Table` for exact values and a small inline SVG (as below) or `Mermaid` for a trend. No chart library is loaded.
- Colours come from CSS variables only (see `theming`). Green, amber and red mean good, watch and bad; do not use them
  for decoration.
- End with what the user should decide or check, as `Choice` or `UserInput`, when there is a decision to make.

```jsx
function StatTile({ label, value, delta, tone = 'neutral', note }) {
	const toneColor = {
		good: 'var(--color-accent-green)',
		watch: 'var(--color-accent-amber)',
		bad: 'var(--color-accent-red)',
		neutral: 'var(--color-text-secondary)',
	}[tone]
	return (
		<div
			style={{
				background: 'var(--color-bg-surface)',
				border: '1px solid var(--color-border-subtle)',
				borderRadius: 8,
				padding: '12px 14px',
				minWidth: 0,
			}}
		>
			<div style={{ color: 'var(--color-text-tertiary)', fontSize: '0.75rem' }}>
				{label}
			</div>
			<div
				style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 4 }}
			>
				<span
					style={{
						color: 'var(--color-text-primary)',
						fontSize: '1.5rem',
						fontWeight: 600,
					}}
				>
					{value}
				</span>
				{delta && (
					<span style={{ color: toneColor, fontSize: '0.8125rem' }}>{delta}</span>
				)}
			</div>
			{note && (
				<div
					style={{
						color: 'var(--color-text-tertiary)',
						fontSize: '0.6875rem',
						marginTop: 4,
					}}
				>
					{note}
				</div>
			)}
		</div>
	)
}

function Sparkline({ values, label }) {
	const min = Math.min(...values)
	const span = Math.max(...values) - min || 1
	const points = values.map((value, index) =>
		`${(index / (values.length - 1)) * 100},${29 - ((value - min) / span) * 28}`
	).join(' ')
	return (
		<svg
			viewBox="0 0 100 30"
			width="100%"
			height="40"
			role="img"
			aria-label={label}
			preserveAspectRatio="none"
		>
			<polyline
				points={points}
				fill="none"
				stroke="var(--color-accent-blue)"
				strokeWidth="1.5"
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	)
}

export default function Canvas() {
	return (
		<>
			<Section title="Checkout latency after the cache change">
				<div
					style={{
						display: 'grid',
						gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
						gap: 12,
					}}
				>
					<StatTile
						label="P95 latency"
						value="182 ms"
						delta="−41%"
						tone="good"
						note="last 24 h vs the 7 days before"
					/>
					<StatTile
						label="Error rate"
						value="0.4%"
						delta="+0.1 pt"
						tone="watch"
						note="5xx from the API gateway log"
					/>
					<StatTile
						label="Cache hit rate"
						value="87%"
						tone="neutral"
						note="new metric, no baseline"
					/>
					<StatTile
						label="Requests"
						value="1.2 M"
						delta="+3%"
						tone="neutral"
						note="normal weekly variation"
					/>
				</div>
			</Section>

			<Section title="Trend">
				<Sparkline
					label="P95 latency per hour, last 24 hours"
					values={[310, 305, 298, 320, 290, 240, 210, 195, 190, 186, 184, 182]}
				/>
				<Note>
					P95 per hour from logs/gateway-2026-11-12.jsonl; the drop starts at the
					10:00 deploy.
				</Note>
			</Section>

			<Section title="By endpoint">
				<Table
					headers={['Endpoint', 'P95 before', 'P95 after', 'Errors']}
					rows={[
						['POST /checkout', '320 ms', '190 ms', '0.6%'],
						['GET /cart', '140 ms', '90 ms', '0.1%'],
						['GET /shipping-options', '410 ms', '400 ms', '0.9%'],
					]}
				/>
				<Callout type="warning">
					GET /shipping-options did not improve; it does not go through the cache
					yet.
				</Callout>
			</Section>

			<Section title="Decide">
				<Choice
					id="next-step"
					label="What next?"
					options={[
						'Put /shipping-options behind the cache too',
						'Look into the error rate first',
						'Good enough, close it',
					]}
				/>
			</Section>
		</>
	)
}
```

Read `component-custom` for the module format and `theming` for the variables. A project can set its own colours
and fonts in `.agent-canvas/theme.css` (see `theming`).
