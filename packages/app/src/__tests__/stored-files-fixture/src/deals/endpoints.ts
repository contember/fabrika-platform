import { NotFoundError } from '@fabrika/app'
import { file, WebhookSecret } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { app } from '../app-kit'

/** A PNG's signature and IHDR head: enough bytes for the sniff. */
export const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]

const Saved = z.strictObject({ id: z.string() })
const Versioned = z.strictObject({ id: z.string(), version: z.int() })
const Empty = z.strictObject({})
export const FileInfo = z.strictObject({
	id: z.uuid(),
	name: z.nullable(z.string()),
	type: z.string(),
	size: z.int(),
	status: z.enum(['pending', 'quarantined', 'live', 'rejected']),
})

export const attachments = app.group({ callers: ['human'] }, (r) => ({
	upload: r.mutation({
		input: z.strictObject({ dealId: z.string(), name: z.string(), file: file('attachments') }),
		output: Saved,
		access: { action: 'deals.write', on: 'deal', from: 'dealId' },
	}).handle(({ input, ctx }) => ctx.db.target.deal_attachments.insert({ file: input.file, name: input.name })),
	uploadMany: r.mutation({
		input: z.strictObject({ dealId: z.string(), files: z.array(file('attachments')).max(3) }),
		output: z.strictObject({ count: z.int() }),
		access: { action: 'deals.write', on: 'deal', from: 'dealId' },
	}).handle(async ({ input, ctx }) => {
		for (const attached of input.files) {
			await ctx.db.target.deal_attachments.insert({ file: attached, name: attached.name ?? 'unnamed' })
		}
		return { count: input.files.length }
	}),
	failing: r.mutation({
		input: z.strictObject({ dealId: z.string(), file: file('attachments') }),
		output: Saved,
		access: { action: 'deals.write', on: 'deal', from: 'dealId' },
	}).handle(async ({ input, ctx }) => {
		await ctx.db.target.deal_attachments.insert({ file: input.file, name: 'rolled back' })
		throw new NotFoundError('the handler gave up after it wrote')
	}),
	list: r.query({
		input: z.strictObject({ dealId: z.string() }),
		output: z.strictObject({ items: z.array(z.strictObject({ id: z.string(), name: z.string(), file: FileInfo })) }),
		access: { action: 'crm.read', on: 'deal', from: 'dealId' },
	}).handle(async ({ ctx }) => {
		const page = await ctx.db.target.deal_attachments.list()
		return { items: page.items.map((row) => ({ id: row.id, name: row.name, file: row.file })) }
	}),
	download: r.query({
		input: z.strictObject({ dealId: z.string(), id: z.string() }),
		output: file('attachments'),
		access: { action: 'crm.read', on: 'deal', from: 'dealId' },
	}).handle(async ({ input, ctx }) => (await ctx.db.target.deal_attachments.get(input.id)).file),
}))

export const catalog = app.group({ callers: ['human'] }, (r) => ({
	addProduct: r.mutation({
		input: z.strictObject({ name: z.string(), image: z.optional(file('catalog')) }),
		output: Versioned,
		access: { action: 'catalog.write', app: true },
	}).handle(({ input, ctx }) => ctx.db.app.products.insert({ name: input.name, image: input.image ?? null })),
	render: r.mutation({
		input: z.strictObject({ name: z.string() }),
		output: Versioned,
		access: { action: 'catalog.write', app: true },
	}).handle(async ({ input, ctx }) => {
		const image = await ctx.files.put('catalog', new Uint8Array(PNG_BYTES), { type: 'image/png', name: `${input.name}.png` })
		return ctx.db.app.products.insert({ name: input.name, image })
	}),
	measure: r.mutation({
		input: z.strictObject({ id: z.string() }),
		output: z.strictObject({ size: z.int(), name: z.nullable(z.string()) }),
		access: { action: 'catalog.write', app: true },
	}).handle(async ({ input, ctx }) => {
		const { image } = await ctx.db.app.products.get(input.id)
		if (image === null) throw new NotFoundError('no image')
		const opened = await ctx.files.open(image)
		return { size: opened.size, name: opened.name }
	}),
	connectScans: r.mutation({
		input: z.strictObject({ account: z.string() }),
		output: WebhookSecret,
		access: { action: 'catalog.write', app: true },
		binds: 'scans',
	}).handle(({ input, ctx }) => ctx.webhooks('scans').bind(ctx.app, input.account)),
	connectInbox: r.mutation({
		input: z.strictObject({ account: z.string() }),
		output: WebhookSecret,
		access: { action: 'catalog.write', app: true },
		binds: 'inbox',
	}).handle(({ input, ctx }) => ctx.webhooks('inbox').bind(ctx.app, input.account)),
	putOnly: r.mutation({
		input: z.strictObject({ name: z.string() }),
		output: Empty,
		access: { action: 'catalog.write', app: true },
	}).handle(async ({ input, ctx }) => {
		await ctx.files.put('catalog', new Uint8Array(PNG_BYTES), { type: 'image/png', name: input.name })
		return {}
	}),
}))

export const shop = app.group({}, (r) => ({
	image: r.query({
		input: z.strictObject({ product: z.string(), file: z.uuid() }),
		output: file('catalog'),
		access: { public: true },
		actions: ['catalog.read'],
		// Its input names the file, so another image is another URL.
		http: { cache: 'immutable' },
	}).handle(async ({ input, ctx }) => {
		const { image } = await ctx.db.app('catalog.read').products.get(input.product)
		if (image === null || image.id !== input.file) throw new NotFoundError('image')
		return image
	}),
}))

export const intake = app.group({}, (r) => ({
	register: r.mutation({
		input: z.strictObject({ name: z.string(), challengeToken: z.string(), photo: z.optional(file('photos')) }),
		output: Empty,
		access: { public: true },
		actions: ['intake.register'],
		admission: {
			challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET', siteKey: 'TURNSTILE_SITE_KEY' },
			rate: { bytesPerHour: 1048576 },
		},
	}).handle(async ({ input, ctx }) => {
		await ctx.db.app('intake.register').submissions.insert({ name: input.name, photo: input.photo ?? null })
		return {}
	}),
}))

/** A provider's delivery that renders a product's image: the webhook puts the file and writes it into the column. */
export const scans = app.webhook('/hooks/scans', {
	scheme: 'stripe',
	boundTo: 'app',
	actions: ['catalog.write'],
	input: z.strictObject({ id: z.string(), type: z.string() }),
}).handle(async ({ input, ctx }) => {
	const image = await ctx.files.put('catalog', new Uint8Array(PNG_BYTES), { type: 'image/png', name: `${input.id}.png` })
	await ctx.db.app('catalog.write').products.insert({ name: input.type, image })
})

/**
 * An inbound mail service that posts each message with its attachments, authenticated by the binding's secret as a
 * bearer token: one product per attached image, in a body larger than the 1 MiB default.
 */
export const inbox = app.webhook('/hooks/inbox', {
	scheme: { bearer: true },
	boundTo: 'app',
	actions: ['catalog.write'],
	input: z.strictObject({
		subject: z.string(),
		attachments: z.array(z.strictObject({ name: z.string(), type: z.literal('image/png'), content: z.string() })).max(8),
	}),
	limits: { maxBytes: 4194304 },
}).handle(async ({ input, ctx }) => {
	for (const attachment of input.attachments) {
		const image = await ctx.files.put('catalog', Buffer.from(attachment.content, 'base64'), { type: attachment.type, name: attachment.name })
		await ctx.db.app('catalog.write').products.insert({ name: `${input.subject}: ${attachment.name}`, image })
	}
})

/** Mails the catalog's images as attachments: each a live file whose reference the job read from its column. */
export const catalogMail = app.cron('0 7 * * *', { actions: ['catalog.read'], mailer: 'installation' }).handle(async ({ ctx }) => {
	const { items } = await ctx.db.app('catalog.read').products.list()
	await ctx.mail.send({
		to: 'buyer@example.com',
		subject: 'The catalog',
		text: 'The images of the catalog are attached.',
		idempotencyKey: `catalog-${ctx.runId}`,
		attachments: items.flatMap((product) => (product.image === null ? [] : [product.image])),
	})
})

/** Mails the photos of the submissions; a photo the scan has not cleared yet is refused. */
export const intakeMail = app.cron('0 8 * * *', { actions: ['intake.drain'], mailer: 'installation', retries: 0 }).handle(
	async ({ ctx }) => {
		const { items } = await ctx.db.app('intake.drain').submissions.list()
		await ctx.mail.send({
			to: 'reviewer@example.com',
			subject: 'New submissions',
			text: 'The photos of the submissions are attached.',
			idempotencyKey: `intake-${ctx.runId}`,
			attachments: items.flatMap((submission) => (submission.photo === null ? [] : [submission.photo])),
		})
	},
)
