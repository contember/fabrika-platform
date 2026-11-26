// Account → Passkeys: passkeys live under IAM's host, so the console's page only points to the passkeys section of the
// person's IAM account page, and says so when the installation does not publish IAM's origin.

import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { passkeysUrl } from '../lib/session'
import { Passkeys } from '../routes/account/passkeys'

describe('Account → Passkeys', () => {
	test("links to the passkeys section of the person's IAM account page", () => {
		const markup = renderToStaticMarkup(<Passkeys passkeysUrl={passkeysUrl('https://iam.example.test')} />)
		expect(markup).toContain('<a href="https://iam.example.test/auth/account#passkeys" class="btn primary">Manage your passkeys</a>')
		expect(markup).toContain('Your passkeys are kept on your IAM account page.')
		expect(markup).not.toContain('role="alert"')
	})

	test("says so, without a link, when the installation does not publish IAM's origin", () => {
		const markup = renderToStaticMarkup(<Passkeys passkeysUrl={null} />)
		expect(markup).toContain('role="alert"')
		expect(markup).toContain('cannot link to your account page')
		expect(markup).not.toContain('<a ')
	})
})
