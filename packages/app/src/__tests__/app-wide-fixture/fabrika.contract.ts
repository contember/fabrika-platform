// Application-wide data (WU23a): an `app` endpoint holds its action as a global grant and reaches `ctx.db.app`.

import { admin } from './src/admin/endpoints'
import { app } from './src/app-kit'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { admin }),
}))
