import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeEmailSenderConformance } from '../conformance.js'
import { DirectoryEmailSender, readCapturedEmails } from '../directory.js'

let directory = ''

describeEmailSenderConformance('DirectoryEmailSender', {
	kind: 'local',
	async create() {
		directory = mkdtempSync(join(tmpdir(), 'fabrika-mail-conformance-'))
		return new DirectoryEmailSender({ directory })
	},
	stored: () => readCapturedEmails(directory),
	async cleanup() {
		rmSync(directory, { recursive: true, force: true })
	},
})
