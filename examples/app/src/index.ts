import { createCloudflareWorker } from '@fabrika/app/cloudflare'
import { app } from './app'

export default createCloudflareWorker(app)
