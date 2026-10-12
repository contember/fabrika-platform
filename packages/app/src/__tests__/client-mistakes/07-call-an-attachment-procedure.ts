import { createClient } from '@fabrika/app/client'
import { contract } from '../kit-fixture/fabrika.contract'

const api = createClient(contract, 'api')

export async function exportDeals(): Promise<unknown> {
	// mistake: an attachment answers a file, so the SPA calls download(api.deals.exportDeals, input)
	return await api.deals.exportDeals({ orgId: 'o1' })
}
