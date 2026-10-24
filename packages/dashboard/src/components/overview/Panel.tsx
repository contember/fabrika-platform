import { type ReactNode, useId } from 'react'

interface PanelProps {
	title: string
	meta?: ReactNode
	aside?: ReactNode
	children: ReactNode
}

export function Panel({ title, meta, aside, children }: PanelProps) {
	const titleId = useId()
	return (
		<section className="overview-panel ov-panel" aria-labelledby={titleId}>
			<div className="ov-section-head">
				<div className="ov-heading-group">
					<h2 id={titleId}>{title}</h2>
					{meta}
				</div>
				{aside}
			</div>
			{children}
		</section>
	)
}
