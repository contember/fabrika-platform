import { createPage, Link } from '@buzola/router'
import { CONTROL_ACTIONS } from '@fabrika/control-contract'
import { useState } from 'react'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Icon } from '../../components/Icon'
import { Chip } from '../../components/Status'
import { EmptyState, Table } from '../../components/Table'
import { api, type MailContentDto, type MailMessageContentDto, type MailMessageDetailDto } from '../../lib/api'
import { holdsGlobally } from '../../lib/console-access'
import { useConsoleAccess } from '../../lib/console-caller'
import { fmtDate } from '../../lib/format'
import { MailState } from './index'

// One relayed message: its metadata, its content for a caller who reads content, and the decision on a held message.
// The HTML body never enters this page's document: it renders in a sandboxed frame that runs no script and loads
// nothing from the network.

export default createPage()
	.params({ id: 'string' })
	.loader(async ({ params }) => ({ message: await api.mail.messages.get({ id: params.id }) }))
	.route('/mail/:id')
	.render(({ data, invalidate }) => {
		const { message } = data
		const access = useConsoleAccess()
		const decides = message.state === 'held' && (access === null || holdsGlobally(access, CONTROL_ACTIONS.MAIL_MANAGE))

		return (
			<>
				<div className="page-head">
					<Link to="mail" className="back-link">
						<Icon name="chevron-left" size={14} />
						All mail
					</Link>
					<div className="page-head-row">
						<div>
							<h1>
								Message <code>{message.id.slice(0, 8)}</code>
							</h1>
							<div className="subtitle">
								<Chip>{message.sender}</Chip>
								<span className="dot-sep">to {message.recipientDomain}</span>
							</div>
						</div>
						<div className="row-actions">
							<MailState state={message.state} />
						</div>
					</div>
				</div>

				<section>
					<div className="detail-grid">
						<Field label="Accepted">{fmtDate(message.createdAt)}</Field>
						<Field label="Updated">{fmtDate(message.updatedAt)}</Field>
						<Field label="Attempts">{message.attempts}</Field>
						{message.nextAttemptAt !== null && <Field label="Next attempt">{fmtDate(message.nextAttemptAt)}</Field>}
						{message.errorCode !== null && (
							<Field label="Last error">
								<code>{message.errorCode}</code>
							</Field>
						)}
						{message.providerMessageId !== null && (
							<Field label="Provider message">
								<code>{message.providerMessageId}</code>
							</Field>
						)}
						<Field label="Decided by rule">{message.ruleId === null ? <span className="muted">none</span> : <code>{message.ruleId}</code>}</Field>
						{message.decidedBy !== null && <Field label="Released or dropped by">{message.decidedBy}</Field>}
					</div>
				</section>

				<MailContent content={message.content} />

				{decides && <Decision message={message} onDone={invalidate} />}
			</>
		)
	})

/** What the recipient sees, or why the page does not show it. */
export function MailContent({ content }: { content: MailContentDto }) {
	if (content.kind === 'withheld') {
		return (
			<p className="hint">
				The content is shown only to a caller who holds <code>{CONTROL_ACTIONS.MAIL_CONTENT_READ}</code>.
			</p>
		)
	}
	if (content.kind === 'purged') {
		return <p className="hint">The relay no longer keeps the content of this message.</p>
	}
	const { message } = content
	return (
		<>
			<section>
				<div className="section-head">
					<Icon name="history" size={15} />
					<h2>Content</h2>
				</div>
				<div className="detail-grid">
					<Field label="To">{message.to}</Field>
					<Field label="Subject" wide>{message.subject}</Field>
					{message.fromName !== undefined && <Field label="From name">{message.fromName}</Field>}
					{message.replyTo !== undefined && <Field label="Reply to">{message.replyTo}</Field>}
					{message.unsubscribeUrl !== undefined && (
						<Field label="Unsubscribe" wide>
							<code>{message.unsubscribeUrl}</code>
						</Field>
					)}
				</div>
				<div className="ops-raw">
					<pre>{message.text}</pre>
				</div>
			</section>
			{message.html !== undefined && <HtmlBody html={message.html} />}
			<Attachments attachments={message.attachments} />
		</>
	)
}

// Prepended to the body: the frame's own policy forbids every fetch, so a tracking image or a remote stylesheet does
// not reach out from the operator's browser. The `sandbox` attribute without tokens already forbids script.
const HTML_BODY_POLICY = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`

function HtmlBody({ html }: { html: string }) {
	return (
		<section>
			<div className="section-head">
				<Icon name="globe" size={15} />
				<h2>HTML body</h2>
			</div>
			<iframe title="HTML body" sandbox="" referrerPolicy="no-referrer" srcDoc={HTML_BODY_POLICY + html} width="100%" height="480" />
			<details>
				<summary>Source</summary>
				<div className="ops-raw">
					<pre>{html}</pre>
				</div>
			</details>
		</section>
	)
}

function Attachments({ attachments }: { attachments: MailMessageContentDto['attachments'] }) {
	return (
		<section>
			<div className="section-head">
				<Icon name="link" size={15} />
				<h2>Attachments</h2>
			</div>
			<Table
				colSpan={3}
				isEmpty={attachments.length === 0}
				empty={<EmptyState icon="link" title="No attachments" body="The message carries its text and HTML body only." />}
				head={
					<tr>
						<th className="grow">Name</th>
						<th>Type</th>
						<th>Size</th>
					</tr>
				}
			>
				{attachments.map((attachment, index) => (
					<tr key={`${index}:${attachment.filename}`}>
						<td>{attachment.filename}</td>
						<td>
							<code>{attachment.contentType}</code>
						</td>
						<td className="small">{attachment.bytes} B</td>
					</tr>
				))}
			</Table>
		</section>
	)
}

/** Release (the page's one constructive step) or drop. Both act on a held message only. */
function Decision({ message, onDone }: { message: MailMessageDetailDto; onDone: () => void }) {
	const [confirming, setConfirming] = useState<'release' | 'drop' | null>(null)

	async function decide(decision: 'release' | 'drop') {
		if (decision === 'release') await api.mail.messages.release({ id: message.id })
		else await api.mail.messages.drop({ id: message.id })
		onDone()
	}

	return (
		<>
			<section>
				<p className="hint">Releasing queues the message for the installation's mail provider; it is sent once and cannot be held again.</p>
				<div className="row-actions">
					<button type="button" className="primary" onClick={() => setConfirming('release')}>Release</button>
				</div>
			</section>
			<div className="danger-zone">
				<div className="danger-zone-copy">
					<strong>Drop this message</strong>
					It is never sent. The sender is not told.
				</div>
				<span className="spacer" />
				<button type="button" className="danger" onClick={() => setConfirming('drop')}>Drop</button>
			</div>
			{confirming !== null && (
				<ConfirmDialog
					title={confirming === 'release' ? 'Release the message' : 'Drop the message'}
					confirmLabel={confirming === 'release' ? 'Release' : 'Drop'}
					body={
						<p>
							{confirming === 'release' ? 'Send' : 'Drop'} the message from <strong>{message.sender}</strong> to {message.recipientDomain}?
						</p>
					}
					onConfirm={() => decide(confirming)}
					onClose={() => setConfirming(null)}
				/>
			)}
		</>
	)
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
	return (
		<div className={wide ? 'wide' : undefined}>
			<h4>{label}</h4>
			{children}
		</div>
	)
}
