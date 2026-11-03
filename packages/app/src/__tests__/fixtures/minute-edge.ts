import { SQL } from 'bun'

/**
 * Waits for the database's next minute when fewer than five seconds of the current one are left. An admission bucket
 * counts calls in one database minute and bytes in one hour (`@fabrika/db` admissions), so a test that expects a bucket
 * to refuse its last call fails when its calls straddle a window's end: the next window admits that call. After this a
 * test has at least five seconds in one window. It may wait six seconds, so the test needs a longer timeout.
 */
export async function awayFromMinuteEdge(url: string): Promise<void> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	let second: number
	try {
		const [row] = await sql.unsafe('select extract(second from now())::float8 as second')
		second = Number(row?.second)
	} finally {
		await sql.close()
	}
	if (second > 55) await Bun.sleep((61 - second) * 1000)
}
