import { z } from 'zod'

/** Shared by the daemon's asset routes and `<FileDrop>`; this module stays free of Node APIs so the client can load it. */
export const ASSET_FIELD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export const storedAssetSchema = z.object({
	/** The stored file's name: a time-ordered random prefix and the sanitised original name. */
	id: z.string(),
	name: z.string(),
	path: z.string(),
	size: z.number().int(),
})
export type StoredAsset = z.infer<typeof storedAssetSchema>
