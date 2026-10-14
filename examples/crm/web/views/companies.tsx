// The companies of the person's orgs, and the dialog that creates one in an org they manage.

import { Can, useInfiniteQuery, useMutation, useQuery } from '@fabrika/app/react'
import { Button, type Column, DataTable, Dialog, Field, Form, FormActions, Input, PageHeader, Select } from '@fabrika/ui'
import { type ReactNode, useState } from 'react'
import { api, type Company } from '../api'
import { orOmitted, text } from '../format'
import { describe, tableState, useReport } from './common'

function NewCompany({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }) {
	const orgs = useQuery(api.orgs.mine)
	const create = useMutation(api.companies.create)
	const report = useReport()
	const close = () => {
		create.reset()
		onClose()
	}
	const submit = async (form: FormData) => {
		const outcome = await create.mutate({ orgId: text(form, 'orgId'), name: text(form, 'name'), website: orOmitted(text(form, 'website')) })
		if (!outcome.ok) return
		report(outcome, 'Company created')
		close()
	}
	const options = orgs.status === 'success' ? orgs.data.orgs.map((org) => ({ value: org, label: org })) : []
	return (
		<Dialog open={open} title="New company" onClose={close}>
			<Form onSubmit={(form) => void submit(form)} error={create.error === null ? null : describe(create.error)} aria-label="New company">
				<Field label="Org" name="orgId" required>
					<Select name="orgId" placeholder="Choose an org" options={options} />
				</Field>
				<Field label="Name" name="name" required>
					<Input name="name" autoComplete="off" />
				</Field>
				<Field label="Website" name="website">
					<Input name="website" type="url" placeholder="https://" />
				</Field>
				<FormActions>
					<Button variant="ghost" onClick={close}>Cancel</Button>
					<Button type="submit" variant="primary" loading={create.pending}>Create company</Button>
				</FormActions>
			</Form>
		</Dialog>
	)
}

export function Companies(): ReactNode {
	const companies = useInfiniteQuery(api.companies.list, {})
	const [creating, setCreating] = useState(false)
	const columns: readonly Column<Company>[] = [
		{ key: 'name', header: 'Name', grow: true, cell: (company) => company.name },
		{
			key: 'website',
			header: 'Website',
			cell: (company) => company.website === null ? '' : <a href={company.website} target="_blank" rel="noreferrer">{company.website}</a>,
		},
		{ key: 'org', header: 'Org', cell: (company) => company.orgId },
	]
	return (
		<>
			<PageHeader
				title="Companies"
				lead="The accounts your orgs sell to."
				actions={
					<Can action="crm.write">
						<Button variant="primary" onClick={() => setCreating(true)}>New company</Button>
					</Can>
				}
			/>
			<DataTable
				caption="Companies"
				columns={columns}
				rows={companies.items}
				rowKey={(company) => company.id}
				{...tableState(companies)}
				empty="No companies yet."
			/>
			<NewCompany open={creating} onClose={() => setCreating(false)} />
		</>
	)
}
