import { app } from '../../kit-fixture/src/app-kit'
import { archive } from './group'

export const contract = app.contract((c) => ({ api: c.rpc('/api', { archive }) }))
