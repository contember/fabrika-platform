import { fromPage, fromRow } from '@fabrika/app'
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { ById, ClearableText, Done, MaybeText, Name, Next, OptionalText, Page, Saved, ScopeValue, Versioned } from '../schemas'

const Company = z.strictObject({ id: z.uuid(), orgId: z.string(), name: z.string(), website: MaybeText, version: z.int() })
const CompanyPage = z.strictObject({ items: z.array(Company), next: Next })
const NewCompany = z.strictObject({ orgId: ScopeValue, name: Name, website: OptionalText })
const EditCompany = z.strictObject({ id: z.uuid(), name: Name, website: ClearableText, expectVersion: z.int().positive() })

export const companies = app.group({ callers: ['human'] }, (r) => ({
	list: r.query({ input: Page, output: CompanyPage, access: { action: 'crm.read', over: 'org' } })
		.handle(async ({ input, ctx }) => fromPage(Company, await ctx.db.within.companies.list({ orderBy: [['name', 'asc']], after: input.after }))),
	get: r.query({ input: ById, output: Company, access: { action: 'crm.read', on: 'company', from: 'id' } })
		.handle(async ({ ctx }) => fromRow(Company, await ctx.db.target.get())),
	create: r.mutation({ input: NewCompany, output: Saved, access: { action: 'crm.write', in: 'org', from: 'orgId' } })
		.handle(({ input, ctx }) => ctx.db.target.companies.insert({ name: input.name, website: input.website ?? null })),
	edit: r.mutation({ input: EditCompany, output: Saved, access: { action: 'crm.write', on: 'company', from: 'id' } })
		.handle(({ input, ctx }) => ctx.db.target.update({ name: input.name, website: input.website }, { expectVersion: input.expectVersion })),
	remove: r.mutation({ input: Versioned, output: Done, access: { action: 'crm.delete', on: 'company', from: 'id' } })
		.handle(({ input, ctx }) => ctx.db.target.remove({ expectVersion: input.expectVersion }).then(() => ({ id: ctx.target.value }))),
}))
