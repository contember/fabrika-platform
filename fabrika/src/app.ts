import { serve } from '@fabrika/app/implement'
import { contract } from '../fabrika.contract'

export default serve(contract, { database: null })
