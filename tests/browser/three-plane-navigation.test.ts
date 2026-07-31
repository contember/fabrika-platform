import { browserTest, byRole, expect, getPage, invariant, step } from '@opice/harness'

const BASE_URL = process.env['FABRIKA_BROWSER_BASE_URL'] ?? 'http://control.localhost:18080'

async function expectConsoleShell(): Promise<void> {
	await expect(byRole('navigation', 'Console navigation')).toBeVisible()
	const shell = byRole('complementary')
	await expect(shell).toContainText('fabrika')
	await expect(shell).toContainText('console')
}

browserTest(
	{
		name: 'An administrator can navigate all three console planes',
		url: `${BASE_URL}/`,
		feature: 'operations-adoption-navigation',
		seeds: ['local-stack'],
		roles: ['admin'],
		tier: 'critical',
	},
	async () => {
		await step('the console overview identifies Delivery, Access, and Operations', {
			intent: 'the unified shell presents all three platform planes from one authenticated entry point',
			manual: 'Open the console overview. Verify that you can see the Delivery, Access, and Operations sections.',
		}, async () => {
			const navigation = byRole('navigation', 'Console navigation')
			await expect(navigation.getByText('Delivery', { exact: true })).toBeVisible()
			await expect(navigation.getByText('Access', { exact: true })).toBeVisible()
			await expect(navigation.getByText('Operations', { exact: true })).toBeVisible()
			await expectConsoleShell()
		})

		await step('Delivery remains reachable through Applications', {
			intent: 'the administrator can enter the Delivery plane without leaving the unified shell',
			manual: 'Select "Applications" under Delivery. Verify that the Applications page opens.',
		}, async () => {
			await byRole('link', 'Applications', { exact: true }).click()
			await expect(getPage()).toHaveURL(`${BASE_URL}/apps`)
			await expect(byRole('heading', 'Applications', { exact: true, level: 1 })).toBeVisible()
			await expectConsoleShell()
		})

		await step('Access remains reachable through its overview', {
			intent: 'the administrator can enter the Access plane from the same navigation',
			manual: 'Select "Overview" under Access. Verify that the Access overview opens.',
		}, async () => {
			await byRole('link', 'Access overview', { exact: true }).click()
			await expect(getPage()).toHaveURL(`${BASE_URL}/access`)
			await expect(byRole('heading', 'Access overview', { exact: true, level: 1 })).toBeVisible()
			await expectConsoleShell()
		})

		await step('Operations overview loads the projected local-stack data', {
			intent: 'the Operations plane is part of the same authenticated console and can read its real service boundary',
			manual: 'Select "Overview" under Operations. Verify that the Operations overview shows its summary cards.',
		}, async () => {
			await byRole('link', 'Operations overview', { exact: true }).click()
			await expect(getPage()).toHaveURL(`${BASE_URL}/operations`)
			await expect(byRole('heading', 'Operations overview', { exact: true, level: 1 })).toBeVisible()

			const main = getPage().locator('main')
			await expect(main.getByRole('link', { name: /^Errors\b/ })).toBeVisible()
			await expect(main.getByRole('link', { name: /^Sources\b/ })).toBeVisible()
			await expect(main.getByRole('link', { name: /^Releases\b/ })).toBeVisible()
			await expect(main.getByRole('link', { name: /^Health\b/ })).toBeVisible()
			await expectConsoleShell()
		})

		await invariant('plane navigation never replaces the Fabrika console shell', async () => {
			await expectConsoleShell()
		})
	},
)
