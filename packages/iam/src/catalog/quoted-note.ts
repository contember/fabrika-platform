import { escapeHtml } from '../html'

/** The HTML of an inviter's personal message: its introduction, then the message escaped and quoted, line breaks kept. */
export function quotedNote(note: { readonly intro: string; readonly message: string } | null): string {
	if (note === null) return ''
	const paragraphs = note.message.replaceAll('\r\n', '\n').split(/\n{2,}/).filter((paragraph) => paragraph.trim() !== '')
	const quoted = paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll('\n', '<br>')}</p>`).join('')
	return `<p>${escapeHtml(note.intro)}</p><blockquote>${quoted}</blockquote>`
}
