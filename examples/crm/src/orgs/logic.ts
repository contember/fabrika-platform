import { BadRequestError } from '@fabrika/app'

type Found = { readonly principalId: string; readonly label: string | null; readonly disabled: boolean } | null

/** A person picked from the org, as its directory answered: an outsider, an unknown id or a disabled member is refused. */
export const picked = (member: Found, role: string) => {
	if (member === null || member.disabled) throw new BadRequestError(`the ${role} is not a member of the org`)
	return { principalId: member.principalId, label: member.label ?? member.principalId }
}
