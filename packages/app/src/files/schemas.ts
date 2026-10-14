// The wire schemas of a collection's list endpoint, shared by the files runtime and the browser client. Browser-safe:
// zod and the contract's limits only. `FILE_LIST_INPUT` and `FILE_LIST_OUTPUT` of the contract describe the same.

import { z } from 'zod/v4'
import { FILE_LIMITS } from '../contract/defaults'

/** `files.<name>.list`'s input. */
export const FileListInput = z.strictObject({
	owner: z.string().min(1),
	after: z.uuid().optional(),
	limit: z.number().int().min(1).max(FILE_LIMITS.listPageMax).optional(),
})
/** A link holder's `<mount>.files.<name>.list`: no owner, which is the link's object; `FILE_LINK_LIST_INPUT` describes it. */
export const FileLinkListInput = FileListInput.omit({ owner: true })
export const FileListOutput = z.strictObject({
	items: z.array(z.strictObject({
		id: z.uuid(),
		name: z.string().min(1).nullable(),
		type: z.string().min(1),
		size: z.number().int().min(0),
		status: z.enum(['live', 'quarantined', 'rejected']),
		createdAt: z.iso.datetime(),
	})).max(FILE_LIMITS.listPageMax),
	next: z.uuid().nullable(),
})
