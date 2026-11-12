import { Marked, marked } from 'marked'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAnnotations } from './AnnotationProvider'
import { generateMarkdown, getMissingRequiredLabels } from './generateMarkdown'
import { useCanvasHost } from './hostContext'

interface ResponsePreviewProps {
	open: boolean
	onClose: () => void
	onSubmit: (feedback: string) => void
	includedRemoteIds: Set<string>
	onToggleRemoteId: (id: string) => void
}

export function ResponsePreview({ open, onClose, onSubmit, includedRemoteIds, onToggleRemoteId }: ResponsePreviewProps) {
	const { annotations, generalNote, submittableResponses, feedbackEntries } = useAnnotations()
	const annotationIds = useCanvasHost().threads !== null
	const [editedText, setEditedText] = useState('')
	const [manuallyEdited, setManuallyEdited] = useState(false)
	const [editMode, setEditMode] = useState(false)
	const [validationError, setValidationError] = useState<string | null>(null)
	const textareaRef = useRef<HTMLTextAreaElement>(null)
	const [prevOpen, setPrevOpen] = useState(false)

	const remoteAnnotations = useMemo(
		() => annotations.filter((a) => a.source === 'remote'),
		[annotations],
	)

	if (open && !prevOpen) {
		setManuallyEdited(false)
		setEditMode(false)
		setValidationError(null)
	}
	if (!open && prevOpen) {
		setManuallyEdited(false)
		setEditMode(false)
		setValidationError(null)
	}
	if (open !== prevOpen) {
		setPrevOpen(open)
	}

	const generatedText = useMemo(
		() => generateMarkdown(annotations, generalNote, submittableResponses, feedbackEntries, includedRemoteIds, { annotationIds }),
		[annotations, generalNote, submittableResponses, feedbackEntries, includedRemoteIds, annotationIds],
	)
	const text = manuallyEdited ? editedText : generatedText

	useEffect(() => {
		if (open && editMode && textareaRef.current) {
			textareaRef.current.focus()
		}
	}, [open, editMode])

	useEffect(() => {
		if (!open) return
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onClose()
		}
		window.addEventListener('keydown', handleKeyDown)
		return () => window.removeEventListener('keydown', handleKeyDown)
	}, [open, onClose])

	if (!open) return null

	const hasContent = text.trim().length > 0

	return (
		<div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-8" onClick={onClose}>
			<div
				className="bg-bg-surface border border-border-medium rounded-xl shadow-lg w-full max-w-2xl flex flex-col"
				style={{ height: '80vh' }}
				onClick={(e) => e.stopPropagation()}
			>
				{/* Header */}
				<div className="flex items-center justify-between px-5 py-3 border-b border-border-subtle flex-shrink-0">
					<div className="flex items-center gap-3">
						<span className="text-[13px] font-medium text-text-primary font-body">Response preview</span>
						{manuallyEdited && (
							<button
								onClick={() => {
									setManuallyEdited(false)
									setEditMode(false)
								}}
								className="text-[11px] text-text-tertiary hover:text-text-secondary font-body"
							>
								Reset
							</button>
						)}
					</div>
					<div className="flex items-center gap-2">
						{/* Mode toggle */}
						<div className="flex items-center bg-bg-base rounded-md p-0.5">
							<button
								onClick={() => setEditMode(false)}
								className={`px-2.5 py-1 rounded text-[11px] font-body font-medium transition-colors ${
									!editMode ? 'bg-bg-elevated text-text-primary shadow-sm' : 'text-text-tertiary hover:text-text-secondary'
								}`}
							>
								Preview
							</button>
							<button
								onClick={() => setEditMode(true)}
								className={`px-2.5 py-1 rounded text-[11px] font-body font-medium transition-colors ${
									editMode ? 'bg-bg-elevated text-text-primary shadow-sm' : 'text-text-tertiary hover:text-text-secondary'
								}`}
							>
								Edit
							</button>
						</div>
						<button
							onClick={onClose}
							className="text-text-tertiary hover:text-text-secondary w-7 h-7 flex items-center justify-center rounded-md hover:bg-border-subtle transition-colors"
						>
							&#x2715;
						</button>
					</div>
				</div>

				{/* Content */}
				{editMode
					? (
						<textarea
							ref={textareaRef}
							value={text}
							onChange={(e) => {
								setEditedText(e.currentTarget.value)
								setManuallyEdited(true)
							}}
							className="flex-1 w-full bg-bg-base p-5 text-[13px] font-mono text-text-code resize-none focus:outline-none leading-relaxed placeholder:text-text-disabled"
							placeholder="Your feedback will appear here..."
						/>
					)
					: (
						<div className="flex-1 overflow-y-auto p-5">
							<MarkdownPreview text={text} />
						</div>
					)}

				{/* Remote feedback summary */}
				{remoteAnnotations.length > 0 && (
					<div className="px-5 py-2 border-t border-border-subtle flex-shrink-0">
						<span className="text-[12px] text-text-secondary font-body">
							Reviewer feedback: {includedRemoteIds.size}/{remoteAnnotations.length} included
						</span>
					</div>
				)}

				{/* Actions */}
				{validationError && (
					<div className="px-5 py-2 text-[12px] text-accent-red font-body border-t border-border-subtle flex-shrink-0 flex items-center justify-between gap-2">
						<span>{validationError}</span>
						<button
							onClick={() => {
								setValidationError(null)
								onSubmit(text)
							}}
							className="text-[11px] text-text-tertiary hover:text-text-secondary font-body whitespace-nowrap underline"
						>
							Submit anyway
						</button>
					</div>
				)}
				<div className="flex justify-end gap-2 px-5 py-3 border-t border-border-subtle flex-shrink-0">
					<button
						onClick={onClose}
						className="px-4 py-2 rounded-lg text-[13px] font-body text-text-tertiary hover:text-text-secondary transition-colors"
					>
						Cancel
					</button>
					<button
						onClick={() => {
							const allMissing = getMissingRequiredLabels(submittableResponses, feedbackEntries)
							if (allMissing.length > 0) {
								setValidationError(`Please answer: ${allMissing.join(', ')}`)
								return
							}
							setValidationError(null)
							onSubmit(text)
						}}
						disabled={!hasContent}
						className={`px-6 py-2 rounded-lg font-body text-[13px] font-medium transition-all ${
							hasContent
								? 'bg-btn-primary text-btn-primary-text hover:opacity-90'
								: 'bg-bg-input text-text-disabled cursor-default'
						}`}
					>
						Submit feedback
					</button>
				</div>
			</div>
		</div>
	)
}

const UPLOADS_PATH_RE = /!\[([^\]]*)\]\((\/tmp\/agent-canvas\/uploads\/([^)]+))\)/g

function rewriteUploadPaths(md: string): string {
	return md.replace(UPLOADS_PATH_RE, (_match, alt, _fullPath, filename) => `![${alt}](/api/uploads/${filename})`)
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char)
/** http(s), mailto, or a URL with no scheme of its own. */
const isSafeUrl = (href: string) => /^(?:https?|mailto):/i.test(href) || !/^[^/?#]*:/.test(href)
const titleAttribute = (title: string | null | undefined) => (title ? ` title="${escapeHtml(title)}"` : '')
// URLs are written escaped, so the browser sees the text that was checked and an entity cannot spell a scheme.
const escapingMarked = new Marked({
	renderer: {
		html: ({ text }) => escapeHtml(text),
		link(token) {
			const text = this.parser.parseInline(token.tokens)
			return isSafeUrl(token.href) ? `<a href="${escapeHtml(token.href)}"${titleAttribute(token.title)}>${text}</a>` : text
		},
		image: (token) =>
			isSafeUrl(token.href)
				? `<img src="${escapeHtml(token.href)}" alt="${escapeHtml(token.text)}"${titleAttribute(token.title)}>`
				: escapeHtml(token.text),
	},
})

/** Renders markdown; `rawHtml: false` shows HTML in it as text, for text the canvas did not author. */
export function MarkdownPreview({ text, rawHtml = true }: { text: string; rawHtml?: boolean }) {
	const html = useMemo(() => (rawHtml ? marked : escapingMarked).parse(rewriteUploadPaths(text), { async: false }), [text, rawHtml])
	// oxlint-disable-next-line react/no-danger -- Canvas modules already execute as code in this document.
	return <div className="prose-canvas font-body text-body text-text-primary leading-relaxed" dangerouslySetInnerHTML={{ __html: html }} />
}
