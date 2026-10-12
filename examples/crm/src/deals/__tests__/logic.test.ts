import { expect, test } from 'bun:test'
import { DEAL_STAGES } from '../../schemas'
import { isClosed } from '../logic'

test('only a won or a lost deal is closed', () => {
	expect(DEAL_STAGES.filter(isClosed)).toEqual(['won', 'lost'])
})
