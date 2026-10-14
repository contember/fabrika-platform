// One deal: its details and edit dialog, its stage, its owner, its tasks, its activity and its attachments.

import { Can, skip, useAction, useInfiniteQuery, useMutation, useQuery } from '@fabrika/app/react'
import {
	Button,
	Card,
	type Column,
	Columns,
	DataTable,
	DateInput,
	Dialog,
	Field,
	FieldList,
	Form,
	FormActions,
	Input,
	PageHeader,
	Section,
	Select,
	SidePanel,
	StatusPill,
	Textarea,
	Timeline,
} from '@fabrika/ui'
import { type ReactNode, useState } from 'react'
import { DEAL_STAGES, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_DEAL } from '../../src/schemas'
import { type Activity, api, type Deal, type Member, type Task } from '../api'
import { uploadAttachment } from '../files'
import { dateTime, day, isClosed, money, nextStage, orNull, orOmitted, stageLabel, stageOf, stageTone, text, wholeNumber } from '../format'
import { href } from '../routes'
import { describe, Loaded, useReport } from './common'

const memberOptions = (members: readonly Member[]) => members.map((member) => ({ value: member.principalId, label: member.label }))

function EditDeal({ deal, open, onClose }: { readonly deal: Deal; readonly open: boolean; readonly onClose: () => void }) {
	const edit = useMutation(api.deals.edit)
	const report = useReport()
	const close = () => {
		edit.reset()
		onClose()
	}
	const submit = async (form: FormData) => {
		const outcome = await edit.mutate({
			id: deal.id,
			title: text(form, 'title'),
			value: wholeNumber(text(form, 'value')),
			source: orNull(text(form, 'source')),
			expectVersion: deal.version,
		})
		if (!outcome.ok) return
		report(outcome, 'Deal saved')
		close()
	}
	return (
		<Dialog open={open} title="Edit deal" onClose={close}>
			<Form key={deal.version} onSubmit={(form) => void submit(form)} error={edit.error === null ? null : describe(edit.error)} aria-label="Edit deal">
				<Field label="Title" name="title" required>
					<Input name="title" defaultValue={deal.title} />
				</Field>
				<Field label="Value (EUR)" name="value" required>
					<Input name="value" inputMode="numeric" defaultValue={String(deal.value)} />
				</Field>
				<Field label="Source" name="source" hint="Leave empty to clear it.">
					<Input name="source" defaultValue={deal.source ?? ''} />
				</Field>
				<FormActions>
					<Button variant="ghost" onClick={close}>Cancel</Button>
					<Button type="submit" variant="primary" loading={edit.pending}>Save</Button>
				</FormActions>
			</Form>
		</Dialog>
	)
}

function StageControl({ deal }: { readonly deal: Deal }) {
	const move = useMutation(api.deals.move)
	const reopen = useMutation(api.deals.reopen)
	const report = useReport()
	if (isClosed(deal.stage)) {
		return (
			<Button onClick={async () => report(await reopen.mutate({ id: deal.id, expectVersion: deal.version }), 'Deal reopened')} loading={reopen.pending}>
				Reopen
			</Button>
		)
	}
	const submit = async (form: FormData) => {
		const stage = stageOf(text(form, 'stage'))
		if (stage !== null) report(await move.mutate({ id: deal.id, stage, expectVersion: deal.version }), `Moved to ${stageLabel(stage)}`)
	}
	return (
		<Form key={deal.version} onSubmit={(form) => void submit(form)} aria-label="Move deal">
			<div className="crm-inline-form">
				<Field label="Move to" name="stage">
					<Select
						name="stage"
						defaultValue={nextStage(deal.stage) ?? deal.stage}
						options={DEAL_STAGES.filter((stage) => stage !== deal.stage).map((stage) => ({ value: stage, label: stageLabel(stage) }))}
					/>
				</Field>
				<Button type="submit" loading={move.pending}>Move</Button>
			</div>
		</Form>
	)
}

function OwnerControl({ deal, members }: { readonly deal: Deal; readonly members: readonly Member[] }) {
	const assign = useMutation(api.deals.assign)
	const report = useReport()
	const submit = async (form: FormData) => {
		const owner = members.find((member) => member.principalId === text(form, 'owner'))
		if (owner !== undefined) {
			report(await assign.mutate({ id: deal.id, newOwner: owner.principalId, expectVersion: deal.version }), `${owner.label} owns it now`)
		}
	}
	return (
		<Form key={deal.version} onSubmit={(form) => void submit(form)} aria-label="Assign owner">
			<div className="crm-inline-form">
				<Field label="New owner" name="owner">
					<Select name="owner" defaultValue={deal.owner} options={memberOptions(members)} />
				</Field>
				<Button type="submit" loading={assign.pending}>Assign</Button>
			</div>
		</Form>
	)
}

function Tasks({ deal, members }: { readonly deal: Deal; readonly members: readonly Member[] }) {
	const tasks = useInfiniteQuery(api.tasks.list, {}, { pages: 'all' })
	const create = useMutation(api.tasks.create)
	const complete = useMutation(api.tasks.complete)
	const report = useReport()
	const [formKey, setFormKey] = useState(0)
	const ofDeal = tasks.items.filter((task) => task.dealId === deal.id)
	const columns: readonly Column<Task>[] = [
		{ key: 'title', header: 'Task', grow: true, cell: (task) => task.title },
		{ key: 'due', header: 'Due', cell: (task) => day(task.dueOn) },
		{ key: 'assignee', header: 'Assignee', cell: (task) => task.assigneeLabel },
		{
			key: 'state',
			header: 'State',
			cell: (task) =>
				task.done
					? <StatusPill tone="success">Done</StatusPill>
					: task.overdue
					? <StatusPill tone="danger">Overdue</StatusPill>
					: <StatusPill>Open</StatusPill>,
		},
		{
			key: 'toggle',
			header: <span className="crm-visually-hidden">Actions</span>,
			align: 'end',
			cell: (task) => (
				<Can action="tasks.write">
					<Button
						size="sm"
						variant="ghost"
						onClick={async () =>
							report(await complete.mutate({ id: task.id, done: !task.done, expectVersion: task.version }), task.done ? 'Task reopened' : 'Task done')}
					>
						{task.done ? 'Not done' : 'Done'}
					</Button>
				</Can>
			),
		},
	]
	const submit = async (form: FormData) => {
		const outcome = await create.mutate({
			dealId: deal.id,
			title: text(form, 'title'),
			dueOn: text(form, 'dueOn'),
			assignee: orOmitted(text(form, 'assignee')),
		})
		if (!outcome.ok) return
		report(outcome, 'Task added')
		setFormKey(formKey + 1)
	}
	return (
		<Section title="Tasks" description="What has to happen next on this deal.">
			<DataTable
				caption="Tasks of this deal"
				columns={columns}
				rows={ofDeal}
				rowKey={(task) => task.id}
				status={tasks.status === 'error' ? 'error' : tasks.status === 'success' ? 'ready' : 'loading'}
				empty="No tasks yet."
			/>
			<Can action="tasks.write">
				<Form key={formKey} onSubmit={(form) => void submit(form)} error={create.error === null ? null : describe(create.error)} aria-label="New task">
					<div className="crm-inline-form">
						<Field label="Task" name="title" required>
							<Input name="title" />
						</Field>
						<Field label="Due on" name="dueOn" required>
							<DateInput name="dueOn" />
						</Field>
						<Field label="Assignee" name="assignee">
							<Select name="assignee" placeholder="Me" options={memberOptions(members)} />
						</Field>
						<Button type="submit" loading={create.pending}>Add task</Button>
					</div>
				</Form>
			</Can>
		</Section>
	)
}

export function ActivityLog(
	{ activities, onLog, pending, error, placeholder, label }: {
		readonly activities: readonly Activity[]
		readonly onLog: (body: string) => Promise<boolean>
		readonly pending: boolean
		readonly error: ReturnType<typeof describe> | null
		readonly placeholder: string
		readonly label: string
	},
) {
	const [formKey, setFormKey] = useState(0)
	return (
		<Section title="Activity">
			<Timeline
				items={activities.map((activity) => ({
					id: activity.id,
					at: dateTime(activity.createdAt),
					title: `${activity.authorLabel} · ${activity.kind}`,
					body: activity.body,
				}))}
				empty="Nothing logged yet."
			/>
			<Can action="activities.write">
				<Form
					key={formKey}
					onSubmit={async (form) => {
						if (await onLog(text(form, 'body'))) setFormKey(formKey + 1)
					}}
					error={error}
					aria-label={label}
				>
					<Field label={label} name="body">
						<Textarea name="body" rows={2} placeholder={placeholder} />
					</Field>
					<FormActions>
						<Button type="submit" loading={pending}>{label}</Button>
					</FormActions>
				</Form>
			</Can>
		</Section>
	)
}

function DealActivity({ deal }: { readonly deal: Deal }) {
	const activities = useInfiniteQuery(api.activities.ofDeal, { dealId: deal.id }, { pages: 'all' })
	const log = useMutation(api.activities.logDeal)
	const report = useReport()
	return (
		<ActivityLog
			activities={activities.items}
			pending={log.pending}
			error={log.error === null ? null : describe(log.error)}
			placeholder="What happened?"
			label="Log note"
			onLog={async (body) => {
				const outcome = await log.mutate({ dealId: deal.id, kind: 'note', body })
				if (outcome.ok) report(outcome, 'Note logged')
				return outcome.ok
			}}
		/>
	)
}

/** Attachments uploaded in this page view: the framework has no endpoint that lists a deal's files. */
const uploadedThisSession = new Map<string, readonly { readonly id: string; readonly name: string }[]>()

function Attachments({ deal }: { readonly deal: Deal }) {
	const [uploads, setUploads] = useState(uploadedThisSession.get(deal.id) ?? [])
	const [formKey, setFormKey] = useState(0)
	const upload = useAction(uploadAttachment)
	const report = useReport()
	const submit = async (form: FormData) => {
		const file = form.get('file')
		if (!(file instanceof File) || file.name === '') return
		const outcome = await upload.mutate({ dealId: deal.id, file })
		if (!outcome.ok) return
		const next = [...uploads, { id: outcome.data.id, name: file.name }]
		uploadedThisSession.set(deal.id, next)
		setUploads(next)
		setFormKey(formKey + 1)
		report(outcome, `${file.name} uploaded`)
	}
	return (
		<Card title="Attachments">
			{uploads.length === 0 ? null : (
				<ul className="crm-files">
					{uploads.map((file) => (
						<li key={file.id}>
							<a href={`/api/files.attachments/${file.id}`} target="_blank" rel="noreferrer">{file.name}</a>
						</li>
					))}
				</ul>
			)}
			<Can action="deals.write">
				<Form key={formKey} onSubmit={(form) => void submit(form)} error={upload.error === null ? null : describe(upload.error)} aria-label="Upload">
					<Field label="File" name="file" hint={`Up to ${MAX_ATTACHMENTS_PER_DEAL} files of at most ${MAX_ATTACHMENT_BYTES / 1048576} MiB each.`}>
						<Input name="file" type="file" />
					</Field>
					<FormActions>
						<Button type="submit" loading={upload.pending}>Upload</Button>
					</FormActions>
				</Form>
			</Can>
		</Card>
	)
}

function DealScreen({ deal }: { readonly deal: Deal }) {
	const company = useQuery(api.companies.get, { id: deal.companyId })
	const members = useQuery(api.orgs.members, company.status === 'success' ? { orgId: company.data.orgId } : skip)
	const [editing, setEditing] = useState(false)
	const move = useMutation(api.deals.move)
	const report = useReport()
	const next = nextStage(deal.stage)
	const people = members.status === 'success' ? members.data.items : []
	return (
		<>
			<PageHeader
				title={deal.title}
				back={{ href: href('deals'), label: 'Deals' }}
				meta={<StatusPill tone={stageTone(deal.stage)}>{stageLabel(deal.stage)}</StatusPill>}
				lead={company.status === 'success' ? `${company.data.name} · ${money(deal.value)}` : money(deal.value)}
				actions={
					<Can action="deals.write">
						<Button onClick={() => setEditing(true)}>Edit</Button>
						{next === null ? null : (
							<Button
								variant="primary"
								loading={move.pending}
								onClick={async () => report(await move.mutate({ id: deal.id, stage: next, expectVersion: deal.version }), `Moved to ${stageLabel(next)}`)}
							>
								Move to {stageLabel(next)}
							</Button>
						)}
					</Can>
				}
			/>
			<Columns>
				<div className="crm-stack">
					<Card title="Details">
						<FieldList
							columns={2}
							items={[
								{ label: 'Company', value: company.status === 'success' ? company.data.name : null },
								{ label: 'Value', value: money(deal.value) },
								{ label: 'Stage', value: stageLabel(deal.stage) },
								{ label: 'Owner', value: deal.ownerLabel },
								{ label: 'Source', value: deal.source },
								{ label: 'Version', value: deal.version },
							]}
						/>
					</Card>
					<Tasks deal={deal} members={people} />
					<DealActivity deal={deal} />
				</div>
				<SidePanel>
					<Can action="deals.write">
						<Card title="Stage">
							<StageControl deal={deal} />
						</Card>
					</Can>
					<Can action="deals.assign">
						<Card title="Owner">
							<OwnerControl deal={deal} members={people} />
						</Card>
					</Can>
					<Attachments deal={deal} />
				</SidePanel>
			</Columns>
			<EditDeal deal={deal} open={editing} onClose={() => setEditing(false)} />
		</>
	)
}

export function DealView({ id }: { readonly id: string }): ReactNode {
	const deal = useQuery(api.deals.get, { id })
	return <Loaded query={deal}>{(found) => <DealScreen deal={found} />}</Loaded>
}
