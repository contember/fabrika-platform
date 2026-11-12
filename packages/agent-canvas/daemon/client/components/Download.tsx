import { MODE } from '../clientApi'

interface DownloadProps {
	/** A file you produced, as an absolute path or one relative to the project root. Write it as a string literal. */
	path: string
	/** The link text; the file name by default. */
	label?: string
}

/** A file the agent hands the user. The daemon serves only a path a canvas of the session names as a literal. */
export function Download({ path, label }: DownloadProps) {
	const name = path.split(/[\\/]/).pop() || 'download'
	if (MODE.isShared) {
		return <p className="text-[13px] font-body text-text-tertiary my-2">{label || name} (download available only on the canvas author's machine)</p>
	}
	const href = `/api/download?session=${encodeURIComponent(MODE.sessionId)}&path=${encodeURIComponent(path)}`
	return (
		<a
			href={href}
			download={name}
			className="inline-flex items-center gap-2 my-2 px-3 py-1.5 rounded-lg border border-border-subtle bg-bg-input text-[13px] font-body text-text-primary hover:border-border-hover"
		>
			<span aria-hidden="true">↓</span>
			{label || name}
		</a>
	)
}
