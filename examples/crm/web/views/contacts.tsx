// The contacts of every company the person can see, one contact with its calls, and the dialogs that create and edit.

import { Can, useInfiniteQuery, useMutation, useQuery } from '@fabrika/app/react'
import { Button, Card, type Column, Columns, DataTable, Dialog, Field, FieldList, Form, FormActions, Input, PageHeader, Select } from '@fabrika/ui'
import { type ReactNode, useState } from 'react'
import { api, type Company, type Contact } from '../api'
import { orNull, orOmitted, text } from '../format'
import { href, Link } from '../routes'
import { describe, Loaded, tableState, useCompanies, useReport } from './common'
import { ActivityLog } from './deal'

function NewContact({ open, onClose, companies }: { readonly open: boolean; readonly onClose: () => void; readonly companies: readonly Company[] }) {
	const create = useMutation(api.contacts.create)
	const report = useReport()
	const close = () => {
		create.reset()
		onClose()
	}
	const submit = async (form: FormData) => {
		const outcome = await create.mutate({
			companyId: text(form, 'companyId'),
			name: text(form, 'name'),
			email: orOmitted(text(form, 'email')),
			phone: orOmitted(text(form, 'phone')),
		})
		if (!outcome.ok) return
		report(outcome, 'Contact created')
		close()
	}
	return (
		<Dialog open={open} title="New contact" onClose={close}>
			<Form onSubmit={(form) => void submit(form)} error={create.error === null ? null : describe(create.error)} aria-label="New contact">
				<Field label="Company" name="companyId" required>
					<Select name="companyId" placeholder="Choose a company" options={companies.map((company) => ({ value: company.id, label: company.name }))} />
				</Field>
				<Field label="Name" name="name" required>
					<Input name="name" autoComplete="off" />
				</Field>
				<Field label="Email" name="email">
					<Input name="email" type="email" />
				</Field>
				<Field label="Phone" name="phone">
					<Input name="phone" type="tel" />
				</Field>
				<FormActions>
					<Button variant="ghost" onClick={close}>Cancel</Button>
					<Button type="submit" variant="primary" loading={create.pending}>Create contact</Button>
				</FormActions>
			</Form>
		</Dialog>
	)
}

export function Contacts(): ReactNode {
	const contacts = useInfiniteQuery(api.contacts.list, {})
	const { companies, name } = useCompanies()
	const [creating, setCreating] = useState(false)
	const columns: readonly Column<Contact>[] = [
		{ key: 'name', header: 'Name', grow: true, cell: (contact) => <Link to="contact" params={{ id: contact.id }}>{contact.name}</Link> },
		{ key: 'company', header: 'Company', cell: (contact) => name(contact.companyId) },
		{ key: 'email', header: 'Email', cell: (contact) => contact.email ?? '' },
		{ key: 'phone', header: 'Phone', cell: (contact) => contact.phone ?? '' },
	]
	return (
		<>
			<PageHeader
				title="Contacts"
				lead="The people at the companies in your orgs."
				actions={
					<Can action="crm.write">
						<Button variant="primary" onClick={() => setCreating(true)}>New contact</Button>
					</Can>
				}
			/>
			<DataTable
				caption="Contacts"
				columns={columns}
				rows={contacts.items}
				rowKey={(contact) => contact.id}
				{...tableState(contacts)}
				empty="No contacts yet."
			/>
			<NewContact open={creating} onClose={() => setCreating(false)} companies={companies} />
		</>
	)
}

function EditContact({ contact, open, onClose }: { readonly contact: Contact; readonly open: boolean; readonly onClose: () => void }) {
	const edit = useMutation(api.contacts.edit)
	const report = useReport()
	const close = () => {
		edit.reset()
		onClose()
	}
	const submit = async (form: FormData) => {
		const outcome = await edit.mutate({
			id: contact.id,
			name: text(form, 'name'),
			email: orNull(text(form, 'email')),
			phone: orNull(text(form, 'phone')),
			expectVersion: contact.version,
		})
		if (!outcome.ok) return
		report(outcome, 'Contact saved')
		close()
	}
	return (
		<Dialog open={open} title="Edit contact" onClose={close}>
			<Form onSubmit={(form) => void submit(form)} error={edit.error === null ? null : describe(edit.error)} aria-label="Edit contact">
				<Field label="Name" name="name" required>
					<Input name="name" defaultValue={contact.name} />
				</Field>
				<Field label="Email" name="email">
					<Input name="email" type="email" defaultValue={contact.email ?? ''} />
				</Field>
				<Field label="Phone" name="phone">
					<Input name="phone" type="tel" defaultValue={contact.phone ?? ''} />
				</Field>
				<FormActions>
					<Button variant="ghost" onClick={close}>Cancel</Button>
					<Button type="submit" variant="primary" loading={edit.pending}>Save</Button>
				</FormActions>
			</Form>
		</Dialog>
	)
}

function ContactActivity({ contact }: { readonly contact: Contact }) {
	const activities = useInfiniteQuery(api.activities.ofContact, { contactId: contact.id }, { pages: 'all' })
	const log = useMutation(api.activities.logContact)
	const report = useReport()
	return (
		<ActivityLog
			activities={activities.items}
			pending={log.pending}
			error={log.error === null ? null : describe(log.error)}
			placeholder="What did you talk about?"
			label="Log call"
			onLog={async (body) => {
				const outcome = await log.mutate({ contactId: contact.id, kind: 'call', body })
				if (outcome.ok) report(outcome, 'Call logged')
				return outcome.ok
			}}
		/>
	)
}

function ContactScreen({ contact }: { readonly contact: Contact }) {
	const company = useQuery(api.companies.get, { id: contact.companyId })
	const [editing, setEditing] = useState(false)
	return (
		<>
			<PageHeader
				title={contact.name}
				back={{ href: href('contacts'), label: 'Contacts' }}
				lead={company.status === 'success' ? company.data.name : undefined}
				actions={
					<Can action="crm.write">
						<Button onClick={() => setEditing(true)}>Edit</Button>
					</Can>
				}
			/>
			<Columns>
				<ContactActivity contact={contact} />
				<Card title="Details">
					<FieldList
						items={[
							{ label: 'Company', value: company.status === 'success' ? company.data.name : null },
							{ label: 'Email', value: contact.email },
							{ label: 'Phone', value: contact.phone },
						]}
					/>
				</Card>
			</Columns>
			<EditContact contact={contact} open={editing} onClose={() => setEditing(false)} />
		</>
	)
}

export function ContactView({ id }: { readonly id: string }): ReactNode {
	const contact = useQuery(api.contacts.get, { id })
	return <Loaded query={contact}>{(found) => <ContactScreen contact={found} />}</Loaded>
}
