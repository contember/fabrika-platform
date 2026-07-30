import { createPage } from '@buzola/router'

export default createPage()
	.loader(async ({ redirect }) => redirect('access/principals'))
	.route('/access')
	.render(() => null)
