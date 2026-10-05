import type { IssueShareLinkRequest } from '@fabrika/iam-contract'
import { z } from 'zod'
import { parseDateTimeLocal } from './format'

const grantRow = z.object({ action: z.string().trim(), scopeType: z.string().trim(), scopeValue: z.string().trim() })
export type GrantRow = z.input<typeof grantRow>

const grants = z.array(grantRow)
	.transform((rows) => rows.filter((row) => row.action !== '' || row.scopeType !== '' || row.scopeValue !== ''))
	.superRefine((rows, context) => {
		if (rows.length === 0) {
			context.addIssue({ code: 'custom', message: 'Add at least one grant.' })
		} else if (rows.some((row) => row.action === '')) {
			context.addIssue({ code: 'custom', message: 'Each grant needs an action.' })
		} else if (rows.some((row) => (row.scopeType === '') !== (row.scopeValue === ''))) {
			context.addIssue({ code: 'custom', message: 'A scope needs both a dimension and a value, or leave both empty for a global grant.' })
		}
	})
	.transform((rows) =>
		rows.map((row) => ({
			action: row.action,
			scope: row.scopeType === '' ? null : { type: row.scopeType, value: row.scopeValue },
		}))
	)

const shareLinkForm = z.object({
	rows: grants,
	app: z.string().min(1, 'Choose the app this link is for.'),
	label: z.string().trim(),
	expiry: z.string().transform(parseDateTimeLocal),
}).transform(({ rows, app, label, expiry }): IssueShareLinkRequest => ({
	app,
	grants: rows,
	...(label === '' ? {} : { label }),
	...(expiry === null ? {} : { expiresAt: expiry }),
}))

export function parseShareLinkForm(input: z.input<typeof shareLinkForm>): IssueShareLinkRequest {
	const parsed = shareLinkForm.safeParse(input)
	if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Issue failed.')
	return parsed.data
}
