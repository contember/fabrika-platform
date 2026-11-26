import { createPage } from '@buzola/router'
import { consoleSession } from '../../lib/session'

/**
 * Where the signed-in person's passkeys are kept: on their IAM account page. Passkeys belong to IAM's host, so only IAM's
 * pages add or remove one; the console only links there.
 */
export default createPage()
	.loader(async () => ({ passkeysUrl: (await consoleSession()).passkeysUrl }))
	.route('/account/passkeys')
	.render(({ data }) => <Passkeys passkeysUrl={data.passkeysUrl} />)

export function Passkeys({ passkeysUrl }: { passkeysUrl: string | null }) {
	return (
		<>
			<div className="page-head">
				<h1>Passkeys</h1>
				<p className="hint">Passkeys confirm sensitive steps in this console, such as deciding an approval that asks for one.</p>
			</div>
			<section>
				<p>
					Your passkeys are kept on your IAM account page. Add or remove one there; a step that asks for a passkey opens IAM's page to confirm it.
				</p>
				{passkeysUrl === null
					? (
						<p className="notice notice-bad" role="alert">
							This installation does not say where IAM is, so the console cannot link to your account page.
						</p>
					)
					: (
						<p>
							<a href={passkeysUrl} className="btn primary">Manage your passkeys</a>
						</p>
					)}
			</section>
		</>
	)
}
