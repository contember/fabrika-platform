import { createClient } from '@fabrika/app/client'
import { useQuery } from '@fabrika/app/react'
import { contract } from '../fixtures/implement/fabrika.contract'

const api = createClient(contract, 'api')

export function useNote() {
	// mistake: an input field the procedure does not declare
	return useQuery(api.notes.get, { noteId: '0190a000-0000-7000-8000-000000000000' })
}
