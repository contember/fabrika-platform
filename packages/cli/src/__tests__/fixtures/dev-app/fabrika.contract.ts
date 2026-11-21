// The application `fabrika app dev`'s own tests serve: cards on boards, a share link of a card, invitations into a
// board (one in the invitee's own language), and a built SPA. Its seed (`dev/seed.ts`) answers a persona, a link page
// and the board it made.

import { app } from './src/app-kit'
import { boards, cards, shared } from './src/cards/endpoints'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { cards, boards }),
	shared,
	site: c.spa('/', { dir: 'site', access: { action: 'cards.read', over: 'board' } }),
}))
