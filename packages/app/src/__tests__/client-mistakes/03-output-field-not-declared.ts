import { createClient } from '@fabrika/app/client'
import { contract } from '../fixtures/implement/fabrika.contract'

const api = createClient(contract, 'api')

export async function score(): Promise<number> {
	const note = await api.notes.get({ id: '0190a0a0-0000-7000-8000-000000000001' })
	// mistake: the output declares id and title only
	return note.internalScore
}
