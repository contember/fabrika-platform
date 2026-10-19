import { app } from '../kit-fixture/src/app-kit'
import { Push } from '../kit-fixture/src/schemas'

export const github = app.webhook('/hooks/github', { scheme: 'github-sha256', boundTo: 'org', actions: ['crm.write'], input: Push })
	.handle(({ ctx }) => {
		// mistake: a webhook writes no file in this release
		ctx.files.put('attachments', new Uint8Array(), { type: 'text/plain', name: 'push.txt' })
	})
