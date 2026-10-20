import { createPage, Link, useNavigate } from '@buzola/router'
import { CONTROL_ACTIONS } from '@fabrika/control-contract'
import { useEffect, useRef, useState } from 'react'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Icon } from '../../components/Icon'
import { QuerySearch } from '../../components/QuerySearch'
import { Chip, type Lamp, Status } from '../../components/Status'
import { EmptyState, Table } from '../../components/Table'
import { api, ApiError, type CursorList, type MailMessageDto, type MailMessageState, type MailRuleAction, type MailRuleDto } from '../../lib/api'
import { holdsGlobally } from '../../lib/console-access'
import { fmtAgo, fmtDate } from '../../lib/format'
import type { QueryLanguage } from '../../lib/query-search'
import { consoleSession } from '../../lib/session'

// Mail: what the relay recorded for applications and installation services. Held messages wait for a person and are
// listed first; the list below filters by state and sender. A caller who reads mail only in some applications names
// a sender (`sender:notes@prod`), because Control lists everything only for a global reader. The gate's rules sit at
// the foot of the page for a caller who manages mail.

interface MailFilter {
	state?: string
	sender?: string
}

export const MAIL_STATES: readonly MailMessageState[] = ['held', 'queued', 'sent', 'failed', 'unknown', 'dropped']

const MAIL_QUERY: QueryLanguage<keyof MailFilter> = {
	qualifiers: [
		{ key: 'state', name: 'state', values: MAIL_STATES },
		{ key: 'sender', name: 'sender', aliases: ['scope'] },
	],
	freeText: false,
}

const NO_PAGE: CursorList<MailMessageDto> = { items: [], nextCursor: null }

export default createPage()
	.params({ state: '?string', sender: '?string' })
	.loader(async ({ params }) => {
		const { access } = await consoleSession()
		const readsAll = access === null || holdsGlobally(access, CONTROL_ACTIONS.MAIL_READ)
		const managesMail = access === null || holdsGlobally(access, CONTROL_ACTIONS.MAIL_MANAGE)
		const state = mailState(params.state)
		const filter = { state: state ?? '', sender: params.sender ?? '' }
		const listable = readsAll || filter.sender !== ''
		const query = { ...(filter.sender === '' ? {} : { scope: filter.sender }) }
		// A refused filter is the list's answer, said above an empty table, not an error that replaces the page.
		const refusal = (cause: unknown) => {
			if (!(cause instanceof ApiError)) throw cause
			return { page: NO_PAGE, refused: cause.message }
		}
		const [held, listed, rules] = await Promise.all([
			listable ? api.mail.messages.list({ ...query, state: 'held' }).then((page) => page.items, () => []) : Promise.resolve([]),
			listable
				? api.mail.messages.list({ ...query, ...(state === undefined ? {} : { state }) }).then((page) => ({ page, refused: null }), refusal)
				: Promise.resolve({ page: NO_PAGE, refused: null }),
			managesMail ? api.mail.rules.list().then((list) => list.items) : Promise.resolve(null),
		])
		return { held, initialMessages: listed.page, refused: listed.refused, listable, filter, rules, loadedAt: Date.now() }
	})
	.route('/mail')
	.render(({ data, invalidate }) => {
		const navigate = useNavigate()
		const [messages, setMessages] = useState<MailMessageDto[]>(data.initialMessages.items)
		const [cursor, setCursor] = useState<string | null>(data.initialMessages.nextCursor)
		const [loading, setLoading] = useState(false)
		const [error, setError] = useState<string | null>(null)
		const current: MailFilter = { state: data.filter.state || undefined, sender: data.filter.sender || undefined }
		const generation = useRef(0)

		useEffect(() => {
			generation.current++
			setMessages(data.initialMessages.items)
			setCursor(data.initialMessages.nextCursor)
			setError(null)
		}, [data.initialMessages])

		async function loadMore() {
			if (cursor === null) return
			const asked = generation.current
			const state = mailState(data.filter.state)
			setLoading(true)
			setError(null)
			try {
				const page = await api.mail.messages.list({
					...(data.filter.sender === '' ? {} : { scope: data.filter.sender }),
					...(state === undefined ? {} : { state }),
					cursor,
				})
				if (asked !== generation.current) return
				setMessages((prev) => [...prev, ...page.items])
				setCursor(page.nextCursor)
			} catch (cause) {
				if (asked === generation.current) setError(cause instanceof ApiError ? cause.message : 'Failed to load messages.')
			} finally {
				setLoading(false)
			}
		}

		return (
			<>
				<div className="page-head">
					<h1>Mail</h1>
					<p className="hint">Mail the relay accepted from applications and installation services, newest first. A held message waits for a person.</p>
				</div>

				{data.held.length > 0 && (
					<section>
						<div className="section-head">
							<Icon name="clock" size={15} />
							<h2>Held</h2>
						</div>
						<MessageTable messages={data.held} current={current} />
					</section>
				)}

				<section>
					<div className="section-head">
						<Icon name="history" size={15} />
						<h2>Messages</h2>
					</div>
					<QuerySearch
						key={data.loadedAt}
						id="mail-search"
						language={MAIL_QUERY}
						label="Search mail"
						filters={current}
						onApply={(filters) => navigate('mail', { params: { state: filters.state, sender: filters.sender }, replace: true })}
						placeholder="state:held sender:notes@prod"
					/>
					{!data.listable && (
						<p className="hint">
							You read the mail of some applications only. Name one sender: <code>sender:notes@prod</code>.
						</p>
					)}
					{data.refused !== null && <p className="error-text" role="alert">{data.refused}</p>}
					{error && <p className="error-text" role="alert">{error}</p>}
					<MessageTable messages={messages} current={current} />
					{cursor !== null && (
						<div className="pager">
							<button type="button" onClick={() => void loadMore()} disabled={loading}>{loading ? 'Loading…' : 'Load more'}</button>
						</div>
					)}
				</section>

				{data.rules !== null && <RulesSection rules={data.rules} onDone={invalidate} />}
			</>
		)
	})

/** `unknown` may have reached the recipient, so it reads as a failure a person looks at, as `failed` does. */
function mailLamp(state: MailMessageState): Lamp {
	switch (state) {
		case 'sent':
			return 'ok'
		case 'queued':
			return 'run'
		case 'failed':
		case 'unknown':
			return 'stop'
		default:
			return 'idle'
	}
}

export function MailState({ state }: { state: MailMessageState }) {
	return <Status lamp={mailLamp(state)}>{state}</Status>
}

function mailState(value: string | undefined): MailMessageState | undefined {
	return MAIL_STATES.find((state) => state === value)
}

function MessageTable({ messages, current }: { messages: readonly MailMessageDto[]; current: MailFilter }) {
	return (
		<Table
			colSpan={6}
			isEmpty={messages.length === 0}
			empty={<EmptyState icon="history" title="No messages match" body="An application sends through the relay once it runs on framework 0.6." />}
			head={
				<tr>
					<th>State</th>
					<th>Sender</th>
					<th className="grow">Recipient domain</th>
					<th>Attempts</th>
					<th>Error</th>
					<th>Accepted</th>
				</tr>
			}
		>
			{messages.map((message) => (
				<tr key={message.id}>
					<td>
						<Link to="mail/detail" params={{ id: message.id }}>
							<MailState state={message.state} />
						</Link>
					</td>
					<td>
						<Link to="mail" params={{ ...current, sender: message.sender }} title="Filter to this sender" className="filter-link">
							<Chip>{message.sender}</Chip>
						</Link>
					</td>
					<td>
						<code>{message.recipientDomain}</code>
					</td>
					<td className="small">{message.attempts}</td>
					<td className="muted small">{message.errorCode ?? ''}</td>
					<td className="muted small" title={fmtDate(message.createdAt)}>{fmtAgo(message.createdAt)}</td>
				</tr>
			))}
		</Table>
	)
}

const RULE_ACTIONS: readonly MailRuleAction[] = ['pass', 'hold', 'drop']

/** The gate decides each application message once, at acceptance, by the most specific rule; no rule passes it. */
function RulesSection({ rules, onDone }: { rules: readonly MailRuleDto[]; onDone: () => void }) {
	return (
		<section>
			<div className="section-head">
				<Icon name="filter" size={15} />
				<h2>Rules</h2>
			</div>
			<p className="section-note">
				The most specific rule decides an application's message when the relay accepts it: the sender's own rule before{' '}
				<code>*</code>, and the exact recipient domain before <code>*</code>. With no rule the message is sent. Installation services are never held.
			</p>
			<Table
				colSpan={4}
				isEmpty={rules.length === 0}
				empty={<EmptyState icon="filter" title="No rules" body="Every application message is sent while Control has a transport." />}
				head={
					<tr>
						<th>Sender</th>
						<th className="grow">Recipient domain</th>
						<th>Action</th>
						<th />
					</tr>
				}
			>
				{rules.map((rule) => <RuleRow key={rule.id} rule={rule} onDone={onDone} />)}
			</Table>
			<SetRuleForm onDone={onDone} />
		</section>
	)
}

function RuleRow({ rule, onDone }: { rule: MailRuleDto; onDone: () => void }) {
	const [confirming, setConfirming] = useState(false)

	async function remove() {
		await api.mail.rules.remove({ id: rule.id })
		onDone()
	}

	return (
		<tr>
			<td>
				<code>{rule.scope}</code>
			</td>
			<td>
				<code>{rule.domain}</code>
			</td>
			<td>
				<Chip>{rule.action}</Chip>
			</td>
			<td className="row-actions">
				<button type="button" className="danger small" onClick={() => setConfirming(true)}>Remove</button>
				{confirming && (
					<ConfirmDialog
						title="Remove mail rule"
						confirmLabel="Remove"
						body={
							<p>
								Remove the rule <strong>{rule.action}</strong> for <code>{rule.scope}</code> to{' '}
								<code>{rule.domain}</code>? Messages accepted later fall to the next rule.
							</p>
						}
						onConfirm={remove}
						onClose={() => setConfirming(false)}
					/>
				)}
			</td>
		</tr>
	)
}

/** Sets the action of a sender and domain pair; an existing rule of the pair changes its action. */
function SetRuleForm({ onDone }: { onDone: () => void }) {
	const [open, setOpen] = useState(false)
	const [scope, setScope] = useState('*')
	const [domain, setDomain] = useState('*')
	const [action, setAction] = useState<MailRuleAction>('hold')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function submit(event: React.FormEvent) {
		event.preventDefault()
		setBusy(true)
		setError(null)
		try {
			await api.mail.rules.set({ scope: scope.trim(), domain: domain.trim().toLowerCase(), action })
			setOpen(false)
			onDone()
		} catch (cause) {
			setError(cause instanceof ApiError ? cause.message : 'Save failed.')
		} finally {
			setBusy(false)
		}
	}

	if (!open) {
		return (
			<div className="add-row">
				<button type="button" className="small" onClick={() => setOpen(true)}>
					<Icon name="plus" size={13} />
					Set rule
				</button>
			</div>
		)
	}

	return (
		<form className="panel form inline" onSubmit={submit}>
			<label>
				Sender
				<input required value={scope} onChange={(event) => setScope(event.target.value)} placeholder="* or notes@prod" autoComplete="off" />
			</label>
			<label>
				Recipient domain
				<input required value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="* or example.com" autoComplete="off" />
			</label>
			<label>
				Action
				<select value={action} onChange={(event) => setAction(RULE_ACTIONS.find((value) => value === event.target.value) ?? 'hold')}>
					{RULE_ACTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
				</select>
			</label>
			<div className="form-actions">
				<button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : 'Set rule'}</button>
				<button type="button" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
			</div>
			{error && <p className="error-text" role="alert">{error}</p>}
		</form>
	)
}
