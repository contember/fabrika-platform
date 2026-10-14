// The local stack's IAM process: the production server with its mail written to `.state/mail/` instead of delivered,
// so forgot-password and invitations work here and a suite reads the links back (`mail-capture.ts`). The sender is a
// composition input, never an environment variable, and IAM refuses it outside `ENVIRONMENT=local`.
import { DirectoryEmailSender } from '@fabrika/email/directory'
import { createRuntime } from '@fabrika/iam/node/runtime'
import { startIamServer } from '@fabrika/iam/node/server'
import { MAIL_DIRECTORY } from './mail-capture'

if (import.meta.main) {
	try {
		startIamServer(createRuntime(process.env, { emailSender: new DirectoryEmailSender({ directory: MAIL_DIRECTORY }) }))
	} catch (error) {
		// Never the error object: a configuration error can quote a connection string.
		console.error('local iam failed to start:', error instanceof Error ? error.message : 'unknown error')
		process.exit(1)
	}
}
