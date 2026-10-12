import { createClient, download } from '@fabrika/app/client'
import { contract } from '../kit-fixture/fabrika.contract'

const api = createClient(contract, 'api')

export async function exportDeals(): Promise<File> {
	// mistake: the procedure's input names the org as orgId
	return await download(api.deals.exportDeals, { org: 'o1' })
}
