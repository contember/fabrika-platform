import type { GrantChangeResponse, GrantDto } from '@fabrika/iam-contract'

/** The grant a change wrote; a test at an application whose grants wait gets a request instead, and fails here. */
export function applied(result: GrantChangeResponse): GrantDto {
	if ('pending' in result) throw new Error(`the grant change waits for approval as request ${result.pending.id}`)
	return result
}
