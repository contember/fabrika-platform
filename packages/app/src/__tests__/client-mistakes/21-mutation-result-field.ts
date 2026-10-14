import { createClient } from '@fabrika/app/client'
import { useMutation } from '@fabrika/app/react'
import { contract } from '../fixtures/implement/fabrika.contract'

const api = createClient(contract, 'api')

export function useCreate() {
	const create = useMutation(api.notes.create)
	return async () => {
		const result = await create.mutate({ workspaceId: 'w1', title: 'Hello' })
		// mistake: the answer is read before the result says the call succeeded
		return result.data.id
	}
}
