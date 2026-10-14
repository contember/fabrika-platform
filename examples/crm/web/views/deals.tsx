// The deals of every company the person can see, filtered by stage and title, and the dialog that creates one.

import { Can, useInfiniteQuery, useMutation } from '@fabrika/app/react'
import { Button, type Column, DataTable, Dialog, Field, FilterBar, Form, FormActions, Input, PageHeader, Select, StatusPill } from '@fabrika/ui'
import { type ReactNode, useState } from 'react'
import { DEAL_STAGES } from '../../src/schemas'
import { api, type Company, type Deal } from '../api'
import { money, orOmitted, stageLabel, stageOf, stageTone, text, wholeNumber } from '../format'
import { Link, navigate } from '../routes'
import { describe, tableState, useCompanies, useReport } from './common'

const STAGE_OPTIONS = DEAL_STAGES.map((stage) => ({ value: stage, label: stageLabel(stage) }))

function NewDeal({ open, onClose, companies }: { readonly open: boolean; readonly onClose: () => void; readonly companies: readonly Company[] }) {
	const create = useMutation(api.deals.create)
	const report = useReport()
	const close = () => {
		create.reset()
		onClose()
	}
	const submit = async (form: FormData) => {
		const outcome = await create.mutate({
			companyId: text(form, 'companyId'),
			title: text(form, 'title'),
			value: wholeNumber(text(form, 'value')),
			source: orOmitted(text(form, 'source')),
		})
		if (!outcome.ok) return
		report(outcome, 'Deal created')
		close()
		navigate('deal', { id: outcome.data.id })
	}
	return (
		<Dialog open={open} title="New deal" description="A deal starts as a lead, owned by you." onClose={close}>
			<Form onSubmit={(form) => void submit(form)} error={create.error === null ? null : describe(create.error)} aria-label="New deal">
				<Field label="Company" name="companyId" required>
					<Select name="companyId" placeholder="Choose a company" options={companies.map((company) => ({ value: company.id, label: company.name }))} />
				</Field>
				<Field label="Title" name="title" required>
					<Input name="title" autoComplete="off" />
				</Field>
				<Field label="Value (EUR)" name="value" required>
					<Input name="value" inputMode="numeric" defaultValue="0" />
				</Field>
				<Field label="Source" name="source" hint="Referral, event, website…">
					<Input name="source" />
				</Field>
				<FormActions>
					<Button variant="ghost" onClick={close}>Cancel</Button>
					<Button type="submit" variant="primary" loading={create.pending}>Create deal</Button>
				</FormActions>
			</Form>
		</Dialog>
	)
}

export function Deals(): ReactNode {
	const deals = useInfiniteQuery(api.deals.list, {})
	const { companies, name } = useCompanies()
	const [creating, setCreating] = useState(false)
	const [stage, setStage] = useState('')
	const [search, setSearch] = useState('')
	const shown = deals.items.filter((deal) =>
		(stage === '' || deal.stage === stageOf(stage)) && deal.title.toLowerCase().includes(search.trim().toLowerCase())
	)
	const columns: readonly Column<Deal>[] = [
		{ key: 'title', header: 'Title', grow: true, cell: (deal) => <Link to="deal" params={{ id: deal.id }}>{deal.title}</Link> },
		{ key: 'company', header: 'Company', cell: (deal) => name(deal.companyId) },
		{ key: 'stage', header: 'Stage', cell: (deal) => <StatusPill tone={stageTone(deal.stage)}>{stageLabel(deal.stage)}</StatusPill> },
		{ key: 'value', header: 'Value', align: 'end', cell: (deal) => money(deal.value) },
		{ key: 'owner', header: 'Owner', cell: (deal) => deal.ownerLabel },
		{ key: 'source', header: 'Source', cell: (deal) => deal.source ?? '' },
	]
	return (
		<>
			<PageHeader
				title="Deals"
				lead="Every deal of the companies in your orgs."
				actions={
					<Can action="deals.write">
						<Button variant="primary" onClick={() => setCreating(true)}>New deal</Button>
					</Can>
				}
			/>
			<FilterBar
				onReset={stage === '' && search === '' ? undefined : () => {
					setStage('')
					setSearch('')
				}}
			>
				<Field label="Stage">
					<Select value={stage} onChange={(event) => setStage(event.currentTarget.value)} placeholder="All stages" options={STAGE_OPTIONS} />
				</Field>
				<Field label="Title">
					<Input type="search" value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder="Search the loaded deals" />
				</Field>
			</FilterBar>
			<DataTable
				caption="Deals"
				columns={columns}
				rows={shown}
				rowKey={(deal) => deal.id}
				{...tableState(deals)}
				empty={stage === '' && search === '' ? 'No deals yet.' : 'No loaded deal matches the filters.'}
			/>
			<NewDeal open={creating} onClose={() => setCreating(false)} companies={companies} />
		</>
	)
}
