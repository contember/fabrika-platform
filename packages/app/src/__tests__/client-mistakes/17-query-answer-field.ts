import { createClient } from '@fabrika/app/client'
import { useQuery } from '@fabrika/app/react'
import { contract } from '../fixtures/implement/fabrika.contract'

const api = createClient(contract, 'api')

export function useBody() {
	const note = useQuery(api.notes.get, { id: '0190a000-0000-7000-8000-000000000000' })
	if (note.status !== 'success') return null
	// mistake: a field the output does not declare
	return note.data.body
}
