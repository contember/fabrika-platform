import { createClient } from '@fabrika/app/client'
import type { DevSeed } from '@fabrika/app/testing'
import { contract } from '../fabrika.contract'

const seed: DevSeed<typeof contract> = async (dev) => {
	const lena = dev.testCaller([{ role: 'lead' }], { label: 'Lena Lindqvist', email: 'lena@cards.example' })
	const api = createClient(contract, 'api', { fetch: dev.browser(lena) })
	const { id } = await api.cards.create({ boardId: 'roadmap', title: 'Ship the preview' })
	const { url } = await api.cards.share({ id })
	await api.boards.invite({ boardId: 'roadmap', email: 'max@cards.example' })
	return {
		personas: [{ name: 'Lena', description: 'Leads every board', caller: lena }],
		links: [{ title: 'The shared card', description: 'What a visitor without an account sees', url }],
		scopes: { board: [{ value: 'roadmap', label: 'Roadmap' }] },
	}
}

export default seed
