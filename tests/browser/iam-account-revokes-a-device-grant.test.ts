import { OAUTH_CLI_CLIENT_ID } from '@fabrika/auth-core'
import { CONTROL_RPC_PATH } from '@fabrika/control-contract'
import { CONTROL_ORIGIN } from '@fabrika/local-stack/ports'
import { browserTest, byRole, expect, getPage, invariant, step } from '@opice/harness'
import { z } from 'zod'
import { expectOnIam, IAM_URL } from './support/notes'

const CONSOLE_URL = process.env['FABRIKA_BROWSER_BASE_URL'] ?? CONTROL_ORIGIN
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

const startSchema = z.object({ device_code: z.string(), verification_uri_complete: z.string(), interval: z.number() })
const tokenSchema = z.object({ refresh_token: z.string() })
const errorSchema = z.object({ error: z.string() })

/** A form POST to IAM's OAuth endpoints, as a command-line client sends it: no cookie, no redirect followed. */
async function oauthPost(path: string, form: Record<string, string>): Promise<Response> {
	return fetch(`${IAM_URL}${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(form),
		redirect: 'manual',
	})
}

browserTest(
	{
		name: 'A person revokes a device grant on their IAM account page, and its next refresh is refused',
		url: `${IAM_URL}/auth/account`,
		feature: 'iam-account-grants',
		seeds: ['local-stack'],
		roles: ['admin'],
		tier: 'standard',
	},
	async () => {
		const resource = `${CONSOLE_URL}${CONTROL_RPC_PATH}`
		let deviceCode = ''
		let verification = ''
		let interval = 5
		let refreshToken = ''
		let listedBefore = 0

		await step('a command-line client starts a device grant', {
			intent: 'the client asks IAM for a device code, as `fabrika login` does',
			manual: 'In a terminal, run `fabrika login --scope=create` against the local console and keep the link it prints.',
		}, async () => {
			const started = startSchema.parse(
				await (await oauthPost('/oauth/device_authorization', { client_id: OAUTH_CLI_CLIENT_ID, scope: 'create', resource })).json(),
			)
			deviceCode = started.device_code
			verification = started.verification_uri_complete
			interval = started.interval
		})

		await step('the person approves it on IAM', {
			intent: 'the signed-in person enters the code and allows the device',
			manual: 'Open the link. Choose "Continue", then "Allow".',
		}, async () => {
			await getPage().goto(verification)
			await byRole('button', 'Continue', { exact: true }).click()
			await expect(byRole('heading', 'Authorize the fabrika command-line client', { exact: true, level: 1 })).toBeVisible()
			await byRole('button', 'Allow', { exact: true }).click()
			await expect(byRole('heading', 'Access granted', { exact: true, level: 1 })).toBeVisible()
		})

		await step('the client receives its grant', {
			intent: 'the next poll after the approval answers a refresh token',
			manual: 'Return to the terminal. It reports that it is signed in.',
		}, async () => {
			await expect.poll(async () => {
				// As the command-line client polls: the resource names which of the approved resources the token is for.
				const answer = await oauthPost('/oauth/token', { grant_type: DEVICE_GRANT, client_id: OAUTH_CLI_CLIENT_ID, device_code: deviceCode, resource })
				if (answer.status !== 200) return false
				refreshToken = tokenSchema.parse(await answer.json()).refresh_token
				return true
			}, { timeout: (interval + 2) * 3000, intervals: [(interval + 1) * 1000] }).toBe(true)
		})

		await step('the account page lists the grant, and revoking it removes it', {
			intent: "the person's own page shows what acts as them and ends it",
			manual:
				'Open /auth/account on IAM. Under "Connected agents and devices", choose "Revoke" in the row of "The fabrika command-line client", then "Revoke" in the dialog that asks.',
		}, async () => {
			await getPage().goto(`${IAM_URL}/auth/account`)
			await expectOnIam('/auth/account')
			await expect(byRole('heading', 'Your account', { exact: true, level: 1 })).toBeVisible()
			// The page lists newest first, so the first match is this run's grant; a reused stack may still hold an earlier run's.
			const items = getPage().getByRole('row').filter({ hasText: 'The fabrika command-line client' }).filter({ hasText: resource })
			await expect(items.first()).toBeVisible()
			listedBefore = await items.count()
			// The row's button names what it revokes; the dialog asks before anything is posted.
			await items.first().getByRole('button', { name: /^Revoke The fabrika command-line client at / }).click()
			await getPage().getByRole('dialog').getByRole('button', { name: 'Revoke', exact: true }).click()
			await expect(getPage().getByRole('status')).toHaveText('Access revoked. It stops within five minutes.')
			await expect(items).toHaveCount(listedBefore - 1)
		})

		await step('the client can no longer refresh', {
			intent: 'a revoked grant refuses its next refresh',
			manual: 'In the terminal, run any command once its access token has expired. It asks you to sign in again.',
		}, async () => {
			const refused = await oauthPost('/oauth/token', {
				grant_type: 'refresh_token',
				client_id: OAUTH_CLI_CLIENT_ID,
				refresh_token: refreshToken,
				resource,
			})
			expect(refused.status).toBe(400)
			expect(errorSchema.parse(await refused.json()).error).toBe('invalid_grant')
		})

		await invariant('a revoked grant is no longer listed on the account page', async () => {
			const items = getPage().getByRole('row').filter({ hasText: 'The fabrika command-line client' }).filter({ hasText: resource })
			await expect(items).toHaveCount(listedBefore - 1)
		})
	},
)
