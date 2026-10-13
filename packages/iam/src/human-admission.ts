import { normalizeEmailIdentity } from './email-identity'
import type { Config } from './services'

/**
 * Whether the installation names `email` as one of the organization's own: a bootstrap admin, an exact entry of
 * `HUMAN_EMAILS`, or an address in a `HUMAN_EMAIL_DOMAINS` domain. A `*` entry names nobody: it admits everyone, and
 * is no statement about who belongs to the organization. IAM never creates such a mailbox as an external principal.
 */
export function organizationMailbox(email: string, config: Pick<Config, 'human' | 'bootstrapAdmins'>): boolean {
	const { emailDomains, emails } = config.human
	const mailbox = normalizeEmailIdentity(email)
	if (emails.some((allowed) => normalizeEmailIdentity(allowed) === mailbox)) {
		return true
	}
	const at = mailbox.lastIndexOf('@')
	const domain = at === -1 ? '' : mailbox.slice(at + 1)
	if (domain !== '' && emailDomains.some((d) => d.toLowerCase() === domain)) {
		return true
	}
	return config.bootstrapAdmins.has(mailbox)
}

/**
 * The human-admission allowlist for self-provisioning a brand-new identity. propustka owns this
 * centrally (the deploy vars `FABRIKA_IAM_HUMAN_EMAIL_DOMAINS` / `FABRIKA_IAM_HUMAN_EMAILS`):
 *   - a `*` entry in EITHER list = admit anyone (allow-all);
 *   - an exact email match in `emails`;
 *   - the email's domain in `emailDomains` (case-insensitive);
 *   - a bootstrap admin.
 * Returns false otherwise — an empty allowlist with no `*` means only known/invited principals and
 * bootstrap admins may log in (fail-closed). Matching uses ONLY the IdP-verified email.
 *
 * Both sides of every comparison are normalized. Entra and Okta both preserve directory casing, so a
 * `FABRIKA_IAM_HUMAN_EMAILS` entry spelled `Vip@Example.com` used to be a control that simply never
 * matched, with nothing said about it either way.
 */
export function admitted(email: string, config: Pick<Config, 'human' | 'bootstrapAdmins'>): boolean {
	const { emailDomains, emails } = config.human
	return emailDomains.includes('*') || emails.includes('*') || organizationMailbox(email, config)
}
