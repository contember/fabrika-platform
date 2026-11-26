// The installation's SCIM token (ADR-0091): an installation administrator's, in a signed-in session, to read, create,
// rotate and remove. A key cannot: the token deprovisions every person of the installation, so the administrator who
// hands it to the identity provider is a person on the record.

import { API_KEY_PREFIX } from '@fabrika/auth-core'
import type { ScimSettingsDto, ScimTokenIssuedDto } from '@fabrika/iam-contract'
import { uuidv7 } from '@fabrika/platform'
import type { ScimTokenRow } from '../repositories/scim'
import { unixNow } from '../repositories/sql'
import { SCIM_BASE_PATH } from '../scim/http'
import { generateToken, hashToken } from '../secret'
import { type AdminContext, adminEvent, fail } from './context'

export async function getScimSettingsUseCase(c: AdminContext): Promise<ScimSettingsDto> {
	requirePersonAdmin(c)
	return settingsDto(c, await c.services.repositories.scim.getToken())
}

/** Create the token, or replace it: the previous one stops working in the same write. The secret is answered once. */
export async function rotateScimTokenUseCase(c: AdminContext): Promise<ScimTokenIssuedDto> {
	requirePersonAdmin(c)
	// `px_`, like every key IAM issues, so the redaction of `px_` patterns covers it in every log.
	const token = `${API_KEY_PREFIX}${generateToken()}`
	const tokenId = uuidv7()
	const row = await c.services.repositories.scim.rotateToken(
		{ tokenId, tokenHash: await hashToken(token), now: unixNow() },
		adminEvent(c, { action: 'iam.scim.token.rotate', resourceType: 'scim_token', resourceId: tokenId }),
	)
	return { ...settingsDto(c, row), configured: true, createdAt: row.created_at, token }
}

export async function revokeScimTokenUseCase(c: AdminContext): Promise<ScimSettingsDto> {
	requirePersonAdmin(c)
	const current = await c.services.repositories.scim.getToken()
	if (current !== null) {
		await c.services.repositories.scim.revokeToken(
			adminEvent(c, { action: 'iam.scim.token.revoke', resourceType: 'scim_token', resourceId: current.token_id }),
		)
	}
	return settingsDto(c, null)
}

function settingsDto(c: AdminContext, row: ScimTokenRow | null): ScimSettingsDto {
	return {
		endpoint: `${c.services.config.issuer.replace(/\/+$/, '')}${SCIM_BASE_PATH}`,
		configured: row !== null,
		createdAt: row?.created_at ?? null,
	}
}

/** `.require(iam.admin)` gates the procedures; the use case also requires a person in a signed-in session. */
function requirePersonAdmin(c: AdminContext): void {
	if (c.administration.kind !== 'installation' || !c.admin.session || c.admin.type !== 'user') {
		return fail(403, "the installation's SCIM token is managed only by an installation administrator in a signed-in session")
	}
}
