import { z } from 'zod/v4'

export const Saved = z.strictObject({ id: z.uuid(), version: z.int() })
export const ById = z.strictObject({ id: z.uuid() })
export const Stage = z.enum(['lead', 'proposal', 'won', 'lost'])
export const Deal = z.strictObject({ id: z.uuid(), title: z.string(), stage: Stage })
export const DealPage = z.strictObject({ items: z.array(Deal), next: z.nullable(z.string()) })
export const ReopenDeal = z.strictObject({ id: z.uuid(), expectVersion: z.int() })
export const OrgInput = z.strictObject({ orgId: z.string() })
export const PipelineRow = z.strictObject({ stage: Stage, deals: z.int() })
export const Pipeline = z.strictObject({ rows: z.array(PipelineRow) })
export const NewCompany = z.strictObject({ orgId: z.string(), name: z.string().min(1) })
export const Company = z.strictObject({ id: z.uuid(), name: z.string() })
export const Product = z.strictObject({ sku: z.string() })
export const ProductName = z.strictObject({ name: z.nullable(z.string()) })
export const Share = z.strictObject({ id: z.uuid(), days: z.int() })
export const Shared = z.strictObject({ url: z.string() })
export const Push = z.strictObject({ ref: z.string() })
export const Ok = z.strictObject({ ok: z.boolean() })
export const Me = z.strictObject({ label: z.string() })
export const Margin = z.strictObject({ margin: z.nullable(z.number()) })
export const Country = z.strictObject({ code: z.string(), name: z.string() })
export const CountryPage = z.strictObject({ items: z.array(Country), next: z.nullable(z.string()) })
export const DealRecord = z.strictObject({
	id: z.uuid(),
	company_id: z.string(),
	org_id: z.string(),
	title: z.string(),
	stage: Stage,
	created_by: z.string(),
	version: z.int(),
})
