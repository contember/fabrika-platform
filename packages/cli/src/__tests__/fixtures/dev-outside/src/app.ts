import { serve } from '@fabrika/app/implement'
import { scoped } from '@fabrika/db'
import { contract } from '../fabrika.contract'
import { tables } from './db/tables'
import { mailer } from './mail'

export default serve(contract, { database: scoped(tables), deps: mailer })
