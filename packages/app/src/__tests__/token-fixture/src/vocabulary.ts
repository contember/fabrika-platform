import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'mailing',
	dimensions: {},
	actions: {
		'mailing.unsubscribe': 'Record that a recipient opts out of a campaign',
		'bookings.book': 'Book a slot as anyone',
		'mail.read': 'Read who opted out',
	},
	roles: {
		staff: { grants: ['mail.read'] },
	},
})
