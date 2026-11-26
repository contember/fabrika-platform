// SCIM provisioning (ADR-0091): the organization's identity provider creates, updates and deprovisions the
// installation's users at IAM's `/scim/v2`, with one bearer token an installation administrator creates and rotates.

/** The installation's SCIM provisioning as the console shows it. */
export interface ScimSettingsDto {
	/** The tenant URL an identity provider is configured with: IAM's origin and `/scim/v2`. */
	endpoint: string
	/** Whether a token exists; without one IAM refuses every SCIM request. */
	configured: boolean
	/** When the current token was created, in epoch seconds; null without one. */
	createdAt: number | null
}

/** A token just created: the secret is in this answer and nowhere else, ever again. */
export interface ScimTokenIssuedDto extends ScimSettingsDto {
	configured: true
	createdAt: number
	token: string
}
