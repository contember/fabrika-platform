import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'cards',
	locale: 'en',
	displayName: 'Cards',
	dimensions: {
		board: { members: { manage: 'members.manage', list: 'cards.read' } },
		card: { in: 'board' },
	},
	actions: {
		'cards.read': 'Read cards',
		'cards.write': 'Write cards',
		'cards.share': 'Share a card by link',
		'members.manage': 'Invite the members of a board',
	},
	roles: {
		lead: { grants: ['cards.read', 'cards.write', 'cards.share', 'members.manage'] },
		member: { grants: ['cards.read', 'cards.write'], member: { scope: 'board', assignableBy: ['lead'] } },
	},
})
