import { createClient } from '@fabrika/app/client'
import { useInfiniteQuery } from '@fabrika/app/react'
import { contract } from '../fixtures/implement/fabrika.contract'

const api = createClient(contract, 'api')

export function useNotes() {
	// mistake: a procedure whose answer is no { items, next } page
	return useInfiniteQuery(api.notes.get, { id: '0190a000-0000-7000-8000-000000000000' })
}
