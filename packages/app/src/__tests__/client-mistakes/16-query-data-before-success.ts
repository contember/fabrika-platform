import { createClient } from '@fabrika/app/client'
import { useQuery } from '@fabrika/app/react'
import { contract } from '../fixtures/implement/fabrika.contract'

const api = createClient(contract, 'api')

export function useTitle() {
	const note = useQuery(api.notes.get, { id: '0190a000-0000-7000-8000-000000000000' })
	// mistake: the answer is read before the status says it arrived
	return note.data.title
}
