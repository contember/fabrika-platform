export function PageHead({ title, description }: { title: string; description: string }) {
	return (
		<div className="page-head">
			<h1>{title}</h1>
			<p className="hint">{description}</p>
		</div>
	)
}
