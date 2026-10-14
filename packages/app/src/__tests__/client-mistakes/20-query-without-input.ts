import { createClient } from '@fabrika/app/client'
import { useQuery } from '@fabrika/app/react'
import { contract } from '../fixtures/implement/fabrika.contract'

const api = createClient(contract, 'api')

export function useNote() {
	// mistake: a procedure with an input called without one
	return useQuery(api.notes.get)
}
