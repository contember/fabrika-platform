// The upload of a deal's attachment. The typed client has no file collections yet (backlog 144), so this is the one
// hand-written call of the SPA, run through `useAction` for its state and its error union.

import { RpcError } from '@fabrika/app/client'
import { z } from 'zod/v4'

const Uploaded = z.strictObject({ result: z.strictObject({ id: z.string() }) })
const Refused = z.object({ error: z.object({ type: z.string(), message: z.string() }) })

export async function uploadAttachment({ dealId, file }: { readonly dealId: string; readonly file: File }): Promise<{ readonly id: string }> {
	const response = await fetch(`/api/files.attachments.upload/${encodeURIComponent(dealId)}?name=${encodeURIComponent(file.name)}`, {
		method: 'POST',
		headers: { 'Content-Type': file.type === '' ? 'application/octet-stream' : file.type },
		body: file,
	})
	const answer: unknown = await response.json().catch(() => null)
	if (!response.ok) {
		const refused = Refused.safeParse(answer)
		throw new RpcError({
			type: refused.success ? refused.data.error.type : 'upload',
			message: refused.success ? refused.data.error.message : `HTTP ${response.status}`,
			httpStatus: response.status,
		})
	}
	return Uploaded.parse(answer).result
}
