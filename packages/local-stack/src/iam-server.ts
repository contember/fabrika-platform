// The local stack's IAM process: the production server with the composition's `directory` provider registered, so its
// mail configuration matches Control's. With `FABRIKA_CONTROL_URL` set, IAM hands each message to Control's relay, which
// writes it to `.state/mail/` (`mail-capture.ts`); forgot-password and invitations work here and a suite reads the
// links back.
import { createRuntime } from '@fabrika/iam/node/runtime'
import { startIamServer } from '@fabrika/iam/node/server'
import { LOCAL_EMAIL_PROVIDERS } from './mail-capture'

async function main(): Promise<void> {
	startIamServer(await createRuntime(process.env, { emailProviders: LOCAL_EMAIL_PROVIDERS }))
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		// Never the error object: a configuration error can quote a connection string.
		console.error('local iam failed to start:', error instanceof Error ? error.message : 'unknown error')
		process.exit(1)
	})
}
