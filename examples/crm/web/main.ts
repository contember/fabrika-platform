// The CRM's single-page UI: hash routes over the typed client of the `/api` mount. It imports the contract and the
// shared schemas only; the SPA build loads the contract without its handlers. Every call goes through the proxy with
// the session cookie, so a refused call shows the proxy's or the application's answer.

import { createClient, RpcError } from '@fabrika/app/client'
import { contract } from '../fabrika.contract'
import { DEAL_STAGES, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_DEAL } from '../src/schemas'
import { el, field, money, options, orNull, orOmitted } from './dom'

const api = createClient(contract, 'api', { bounceOnAuth: true })

type Stage = (typeof DEAL_STAGES)[number]
type Deal = Awaited<ReturnType<typeof api.deals.get>>
type Company = Awaited<ReturnType<typeof api.companies.get>>
type Activity = Awaited<ReturnType<typeof api.activities.ofDeal>>['items'][number]
type Member = { readonly principalId: string; readonly label: string }

const root = document.getElementById('app')
const status = el('p', { class: 'status', role: 'status' })

/** Every item of a paged list: the API answers at most one page per call. */
async function all<T>(page: (after: string | undefined) => Promise<{ readonly items: readonly T[]; readonly next: string | null }>): Promise<T[]> {
	const items: T[] = []
	let after: string | undefined
	do {
		const answer = await page(after)
		items.push(...answer.items)
		after = answer.next ?? undefined
	} while (after !== undefined)
	return items
}

const listCompanies = () => all((after) => api.companies.list({ after }))

function report(error: unknown): void {
	status.textContent = error instanceof RpcError ? `Refused (${error.httpStatus ?? '?'}): ${error.message}` : 'Something went wrong'
}

/** Runs one user action and redraws the route; a refusal is shown instead of a crash. */
async function act(run: () => Promise<unknown>): Promise<void> {
	status.textContent = ''
	try {
		await run()
		await render()
	} catch (error) {
		report(error)
	}
}

function submit(handler: (form: HTMLFormElement) => Promise<unknown>): (event: Event) => void {
	return (event) => {
		event.preventDefault()
		const form = event.currentTarget
		if (form instanceof HTMLFormElement) void act(() => handler(form))
	}
}

function stageOf(value: string): Stage {
	const stage = DEAL_STAGES.find((candidate) => candidate === value)
	if (stage === undefined) throw new Error(`unknown stage ${value}`)
	return stage
}

const isClosed = (stage: Stage): boolean => stage === 'won' || stage === 'lost'
const companyName = (companies: readonly Company[], id: string): string => companies.find((company) => company.id === id)?.name ?? '?'

/** The members of an org who have a label: the people a deal's owner or a task's assignee is picked from. */
async function membersOf(orgId: string): Promise<Member[]> {
	const { items } = await api.orgs.members({ orgId })
	return items.flatMap((member) => (member.label === null ? [] : [{ principalId: member.principalId, label: member.label }]))
}

function memberOf(members: readonly Member[], principalId: string): Member | null {
	return members.find((member) => member.principalId === principalId) ?? null
}

const memberPicker = (members: readonly Member[], selected?: string) =>
	el('select', { name: 'member', 'aria-label': 'Member' }, ...options(members.map((m) => ({ value: m.principalId, label: m.label })), selected))

async function pipelineView(): Promise<HTMLElement> {
	const [deals, { stages }, companies] = await Promise.all([all((after) => api.deals.list({ after })), api.deals.pipeline(), listCompanies()])
	const column = (stage: Stage) => {
		const total = stages.find((entry) => entry.stage === stage)
		const next = DEAL_STAGES[DEAL_STAGES.indexOf(stage) + 1]
		const advance = (deal: Deal) =>
			isClosed(deal.stage)
				? el('button', { type: 'button', click: () => void act(() => api.deals.reopen({ id: deal.id, expectVersion: deal.version })) }, 'Reopen')
				: next === undefined
				? null
				: el('button', {
					type: 'button',
					click: () => void act(() => api.deals.move({ id: deal.id, stage: next, expectVersion: deal.version })),
				}, `→ ${next}`)
		return el(
			'section',
			{ class: 'stage', 'data-stage': stage },
			el('h3', {}, `${stage} (${total?.count ?? 0}) · ${money(total?.value ?? 0)}`),
			...deals.filter((deal) => deal.stage === stage).map((deal) =>
				el(
					'div',
					{ class: 'card' },
					el('a', { href: `#/deal/${deal.id}` }, deal.title),
					el('div', {}, `${companyName(companies, deal.companyId)} · ${money(deal.value)} · ${deal.ownerLabel}`),
					advance(deal),
				)
			),
		)
	}
	return el('div', {}, el('h2', {}, 'Pipeline'), el('div', { class: 'pipeline' }, ...DEAL_STAGES.map(column)))
}

async function dealsView(): Promise<HTMLElement> {
	const [deals, companies] = await Promise.all([all((after) => api.deals.list({ after })), listCompanies()])
	const form = el(
		'form',
		{
			id: 'new-deal',
			submit: submit((form) =>
				api.deals.create({
					companyId: field(form, 'companyId'),
					title: field(form, 'title'),
					value: Number(field(form, 'value')),
					source: orOmitted(field(form, 'source')),
				})
			),
		},
		el('select', { name: 'companyId', 'aria-label': 'Company' }, ...options(companies.map((company) => ({ value: company.id, label: company.name })))),
		el('input', { name: 'title', placeholder: 'Title', required: '' }),
		el('input', { name: 'value', type: 'number', min: '0', value: '0', 'aria-label': 'Value' }),
		el('input', { name: 'source', placeholder: 'Source (referral, event…)' }),
		el('button', { type: 'submit' }, 'Create deal'),
	)
	return el(
		'div',
		{},
		el('h2', {}, 'Deals'),
		el(
			'table',
			{},
			el('tr', {}, ...['Title', 'Company', 'Stage', 'Value', 'Owner', 'Source'].map((heading) => el('th', {}, heading))),
			...deals.map((deal) =>
				el(
					'tr',
					{},
					el('td', {}, el('a', { href: `#/deal/${deal.id}` }, deal.title)),
					el('td', {}, companyName(companies, deal.companyId)),
					el('td', {}, deal.stage),
					el('td', {}, money(deal.value)),
					el('td', {}, deal.ownerLabel),
					el('td', {}, deal.source ?? ''),
				)
			),
		),
		el('h3', {}, 'New deal'),
		form,
	)
}

/** Attachments uploaded in this page view: the framework has no endpoint that lists a deal's files. */
const uploadedThisSession = new Map<string, { readonly id: string; readonly name: string }[]>()

async function dealView(id: string): Promise<HTMLElement> {
	const [deal, tasks, activities] = await Promise.all([
		api.deals.get({ id }),
		all((after) => api.tasks.list({ after })),
		all((after) => api.activities.ofDeal({ dealId: id, after })),
	])
	const company = await api.companies.get({ id: deal.companyId })
	const members = await membersOf(company.orgId)
	const uploads = uploadedThisSession.get(id) ?? []
	return el(
		'div',
		{},
		el('h2', {}, deal.title),
		el('p', {}, `${company.name} · ${deal.stage} · ${money(deal.value)} · owned by ${deal.ownerLabel} · version ${deal.version}`),
		editDealForm(deal),
		isClosed(deal.stage)
			? el('button', { type: 'button', click: () => void act(() => api.deals.reopen({ id, expectVersion: deal.version })) }, 'Reopen')
			: el(
				'form',
				{ id: 'move-deal', submit: submit((form) => api.deals.move({ id, stage: stageOf(field(form, 'stage')), expectVersion: deal.version })) },
				el('select', { name: 'stage', 'aria-label': 'Stage' }, ...options(DEAL_STAGES.map((stage) => ({ value: stage, label: stage })), deal.stage)),
				el('button', { type: 'submit' }, 'Move'),
			),
		el(
			'form',
			{
				id: 'assign-deal',
				submit: submit(async (form) => {
					const owner = memberOf(members, field(form, 'member'))
					if (owner !== null) await api.deals.assign({ id, newOwner: owner.principalId, expectVersion: deal.version })
				}),
			},
			memberPicker(members, deal.owner),
			el('button', { type: 'submit' }, 'Assign owner'),
		),
		el('h3', {}, 'Tasks'),
		el(
			'ul',
			{},
			...tasks.filter((task) => task.dealId === id).map((task) =>
				el(
					'li',
					{ class: task.overdue && !task.done ? 'overdue' : '' },
					`${task.done ? '[x]' : '[ ]'} ${task.title} · due ${task.dueOn} · ${task.assigneeLabel}${task.overdue ? ' · overdue' : ''} `,
					el(
						'button',
						{ type: 'button', click: () => void act(() => api.tasks.complete({ id: task.id, done: !task.done, expectVersion: task.version })) },
						task.done ? 'Not done' : 'Done',
					),
				)
			),
		),
		el(
			'form',
			{
				id: 'new-task',
				submit: submit((form) =>
					api.tasks.create({
						dealId: id,
						title: field(form, 'title'),
						dueOn: field(form, 'dueOn'),
						assignee: memberOf(members, field(form, 'member'))?.principalId,
					})
				),
			},
			el('input', { name: 'title', placeholder: 'Task', required: '' }),
			el('input', { name: 'dueOn', type: 'date', required: '', 'aria-label': 'Due on' }),
			memberPicker(members),
			el('button', { type: 'submit' }, 'Add task'),
		),
		el('h3', {}, 'Activities'),
		activityList(activities),
		el(
			'form',
			{ id: 'log-deal-activity', submit: submit((form) => api.activities.logDeal({ dealId: id, kind: 'note', body: field(form, 'body') })) },
			el('input', { name: 'body', placeholder: 'Note', required: '' }),
			el('button', { type: 'submit' }, 'Log note'),
		),
		el('h3', {}, 'Attachments'),
		el('p', {}, `Up to ${MAX_ATTACHMENTS_PER_DEAL} files of at most ${MAX_ATTACHMENT_BYTES / 1048576} MiB each.`),
		el('ul', {}, ...uploads.map((file) => el('li', {}, el('a', { href: `/api/files.attachments/${file.id}`, target: '_blank' }, file.name)))),
		el(
			'form',
			{ id: 'upload', submit: submit((form) => upload(id, form)) },
			el('input', { name: 'file', type: 'file', required: '', 'aria-label': 'Attachment' }),
			el('button', { type: 'submit' }, 'Upload'),
		),
	)
}

function editDealForm(deal: Deal): HTMLElement {
	return el(
		'form',
		{
			id: 'edit-deal',
			submit: submit((form) =>
				api.deals.edit({
					id: deal.id,
					title: field(form, 'title'),
					value: Number(field(form, 'value')),
					source: orNull(field(form, 'source')),
					expectVersion: deal.version,
				})
			),
		},
		el('input', { name: 'title', value: deal.title, required: '', 'aria-label': 'Title' }),
		el('input', { name: 'value', type: 'number', min: '0', value: String(deal.value), 'aria-label': 'Value' }),
		el('input', { name: 'source', value: deal.source ?? '', placeholder: 'Source', 'aria-label': 'Source' }),
		el('button', { type: 'submit' }, 'Save'),
	)
}

async function upload(dealId: string, form: HTMLFormElement): Promise<void> {
	const file = new FormData(form).get('file')
	if (!(file instanceof File)) return
	const response = await fetch(`/api/files.attachments.upload/${dealId}?name=${encodeURIComponent(file.name)}`, {
		method: 'POST',
		headers: { 'Content-Type': file.type || 'application/octet-stream' },
		body: file,
	})
	if (!response.ok) throw new RpcError({ type: 'upload', message: 'upload refused', httpStatus: response.status })
	const answer: unknown = await response.json()
	const id = typeof answer === 'object' && answer !== null && 'result' in answer && typeof answer.result === 'object' && answer.result !== null
			&& 'id' in answer.result && typeof answer.result.id === 'string'
		? answer.result.id
		: null
	if (id === null) throw new Error('the upload answered no file id')
	uploadedThisSession.set(dealId, [...(uploadedThisSession.get(dealId) ?? []), { id, name: file.name }])
}

function activityList(items: readonly Activity[]) {
	return el(
		'ul',
		{ class: 'activities' },
		...items.map((item) => el('li', {}, `${item.createdAt.slice(0, 16)} · ${item.kind} · ${item.authorLabel}: ${item.body}`)),
	)
}

async function contactsView(): Promise<HTMLElement> {
	const [contacts, companies] = await Promise.all([all((after) => api.contacts.list({ after })), listCompanies()])
	return el(
		'div',
		{},
		el('h2', {}, 'Contacts'),
		el(
			'table',
			{},
			el('tr', {}, ...['Name', 'Company', 'Email', 'Phone'].map((heading) => el('th', {}, heading))),
			...contacts.map((contact) =>
				el(
					'tr',
					{},
					el('td', {}, el('a', { href: `#/contact/${contact.id}` }, contact.name)),
					el('td', {}, companyName(companies, contact.companyId)),
					el('td', {}, contact.email ?? ''),
					el('td', {}, contact.phone ?? ''),
				)
			),
		),
		el('h3', {}, 'New contact'),
		el(
			'form',
			{
				id: 'new-contact',
				submit: submit((form) =>
					api.contacts.create({
						companyId: field(form, 'companyId'),
						name: field(form, 'name'),
						email: orOmitted(field(form, 'email')),
						phone: orOmitted(field(form, 'phone')),
					})
				),
			},
			el('select', { name: 'companyId', 'aria-label': 'Company' }, ...options(companies.map((company) => ({ value: company.id, label: company.name })))),
			el('input', { name: 'name', placeholder: 'Name', required: '' }),
			el('input', { name: 'email', placeholder: 'Email' }),
			el('input', { name: 'phone', placeholder: 'Phone' }),
			el('button', { type: 'submit' }, 'Create contact'),
		),
	)
}

async function contactView(id: string): Promise<HTMLElement> {
	const [contact, activities] = await Promise.all([api.contacts.get({ id }), all((after) => api.activities.ofContact({ contactId: id, after }))])
	return el(
		'div',
		{},
		el('h2', {}, contact.name),
		el(
			'form',
			{
				id: 'edit-contact',
				submit: submit((form) =>
					api.contacts.edit({
						id,
						name: field(form, 'name'),
						email: orNull(field(form, 'email')),
						phone: orNull(field(form, 'phone')),
						expectVersion: contact.version,
					})
				),
			},
			el('input', { name: 'name', value: contact.name, required: '', 'aria-label': 'Name' }),
			el('input', { name: 'email', value: contact.email ?? '', 'aria-label': 'Email' }),
			el('input', { name: 'phone', value: contact.phone ?? '', 'aria-label': 'Phone' }),
			el('button', { type: 'submit' }, 'Save'),
		),
		el('h3', {}, 'Activities'),
		activityList(activities),
		el(
			'form',
			{
				id: 'log-contact-activity',
				submit: submit((form) => api.activities.logContact({ contactId: id, kind: 'call', body: field(form, 'body') })),
			},
			el('input', { name: 'body', placeholder: 'Call summary', required: '' }),
			el('button', { type: 'submit' }, 'Log call'),
		),
	)
}

async function companiesView(): Promise<HTMLElement> {
	const [companies, { orgs }] = await Promise.all([listCompanies(), api.orgs.mine()])
	return el(
		'div',
		{},
		el('h2', {}, 'Companies'),
		el('ul', {}, ...companies.map((company) => el('li', {}, `${company.name}${company.website === null ? '' : ` · ${company.website}`}`))),
		el('h3', {}, 'New company'),
		el(
			'form',
			{
				id: 'new-company',
				submit: submit((form) =>
					api.companies.create({ orgId: field(form, 'orgId'), name: field(form, 'name'), website: orOmitted(field(form, 'website')) })
				),
			},
			el('select', { name: 'orgId', 'aria-label': 'Org' }, ...options(orgs.map((org) => ({ value: org, label: org })))),
			el('input', { name: 'name', placeholder: 'Name', required: '' }),
			el('input', { name: 'website', placeholder: 'Website' }),
			el('button', { type: 'submit' }, 'Create company'),
		),
	)
}

async function tasksView(): Promise<HTMLElement> {
	const tasks = await all((after) => api.tasks.list({ after }))
	return el(
		'div',
		{},
		el('h2', {}, 'Tasks'),
		el(
			'ul',
			{},
			...tasks.map((task) =>
				el(
					'li',
					{ class: task.overdue && !task.done ? 'overdue' : '' },
					el('a', { href: `#/deal/${task.dealId}` }, task.title),
					` · due ${task.dueOn} · ${task.assigneeLabel}${task.done ? ' · done' : ''}${task.overdue ? ' · overdue' : ''}`,
				)
			),
		),
	)
}

async function route(): Promise<HTMLElement> {
	const [, view, id] = location.hash.split('/')
	if (view === 'deal' && id !== undefined) return dealView(id)
	if (view === 'contact' && id !== undefined) return contactView(id)
	if (view === 'deals') return dealsView()
	if (view === 'contacts') return contactsView()
	if (view === 'companies') return companiesView()
	if (view === 'tasks') return tasksView()
	return pipelineView()
}

async function render(): Promise<void> {
	if (root === null) return
	const nav = el('nav', {}, ...['pipeline', 'deals', 'contacts', 'companies', 'tasks'].map((view) => el('a', { href: `#/${view}` }, view)))
	try {
		const view = await route()
		root.replaceChildren(nav, status, view)
	} catch (error) {
		report(error)
		root.replaceChildren(nav, status)
	}
}

window.addEventListener('hashchange', () => {
	status.textContent = ''
	void render()
})
void render()
