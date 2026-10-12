import { fromRow } from '@fabrika/app'
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { ById, Done, MaybeText, Name, Next, OptionalText, Page, Saved, Versioned } from '../schemas'

const Contact = z.strictObject({ id: z.uuid(), companyId: z.uuid(), name: z.string(), email: MaybeText, phone: MaybeText, version: z.int() })
const ContactPage = z.strictObject({ items: z.array(Contact), next: Next })
const NewContact = z.strictObject({ companyId: z.uuid(), name: Name, email: OptionalText, phone: OptionalText })
const EditContact = z.strictObject({ id: z.uuid(), name: Name, email: OptionalText, phone: OptionalText, expectVersion: z.int().positive() })

export const contacts = app.group({ callers: ['human'] }, (r) => ({
	list: r.query({ input: Page, output: ContactPage, access: { action: 'crm.read', over: 'company' } })
		.handle(async ({ input, ctx }) => {
			const page = await ctx.db.within.contacts.list({ orderBy: [['name', 'asc']], after: input.after })
			return { items: page.items.map((row) => fromRow(Contact, row)), next: page.next }
		}),
	get: r.query({ input: ById, output: Contact, access: { action: 'crm.read', on: 'contact', from: 'id' } })
		.handle(async ({ ctx }) => fromRow(Contact, await ctx.db.target.get())),
	create: r.mutation({ input: NewContact, output: Saved, access: { action: 'crm.write', in: 'company', from: 'companyId' } })
		.handle(({ input, ctx }) => ctx.db.target.contacts.insert({ name: input.name, email: input.email, phone: input.phone })),
	edit: r.mutation({ input: EditContact, output: Saved, access: { action: 'crm.write', on: 'contact', from: 'id' } })
		.handle(({ input: { expectVersion, ...contact }, ctx }) => ctx.db.target.update(contact, { expectVersion })),
	remove: r.mutation({ input: Versioned, output: Done, access: { action: 'crm.delete', on: 'contact', from: 'id' } })
		.handle(async ({ input, ctx }) => {
			await ctx.db.target.remove({ expectVersion: input.expectVersion })
			return { id: ctx.target.value }
		}),
}))
