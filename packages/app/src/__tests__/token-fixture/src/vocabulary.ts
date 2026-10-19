import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'mailing',
	dimensions: {},
	actions: {
		'mailing.unsubscribe': 'Record that a recipient opts out of a campaign',
		'bookings.book': 'Book a slot as anyone',
		'bookings.manage': 'Move or cancel the booking a management link names',
		'stats.click': 'Count a click on a tracked link',
		'mail.read': 'Read who opted out',
	},
	roles: {
		staff: { grants: ['mail.read'] },
	},
})
