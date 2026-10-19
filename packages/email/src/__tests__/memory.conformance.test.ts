import { describeEmailSenderConformance, wireMessageOf } from '../conformance.js'
import { MemoryEmailSender } from '../memory.js'

let sender = new MemoryEmailSender()

describeEmailSenderConformance('MemoryEmailSender', {
	kind: 'local',
	async create() {
		sender = new MemoryEmailSender()
		return sender
	},
	async stored() {
		return sender.accepted.map((email) => wireMessageOf(email.message))
	},
})
