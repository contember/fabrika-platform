import { createClient } from '@fabrika/app/client'
import { useMutation } from '@fabrika/app/react'
import { contract } from '../fixtures/implement/fabrika.contract'

const api = createClient(contract, 'api')

export function useCreate() {
	const create = useMutation(api.notes.create)
	// mistake: the input misses a required field
	return () => create.mutate({ title: 'Hello' })
}
