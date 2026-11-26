import { Fragment, type ReactNode } from 'react'
import type { AppEnvDto } from '../../lib/api'
import type { LayeredEntry, LayeredName } from '../../lib/config-layers'
import { Table } from '../Table'

/** One row per name, one column per layer: all environments first, then each environment. */
export function LayerTable<T extends LayeredEntry>(
	{ rows, envs, empty, cell, after }: {
		rows: readonly LayeredName<T>[]
		envs: readonly AppEnvDto[]
		empty: ReactNode
		/** The cell of `row` on a layer; `env` null is the layer for all environments. */
		cell: (row: LayeredName<T>, env: string | null) => ReactNode
		/** A row of its own under `row`, spanning every column: the editor of one of its layers, when open. */
		after: (row: LayeredName<T>, columns: number) => ReactNode
	},
) {
	return (
		<Table
			colSpan={2 + envs.length}
			isEmpty={rows.length === 0}
			empty={empty}
			head={
				<tr>
					<th className="grow">Name</th>
					<th className="layer-head">All environments</th>
					{envs.map((env) => <th key={env.env} className="layer-head">{env.env}</th>)}
				</tr>
			}
		>
			{rows.map((row) => (
				<Fragment key={row.name}>
					<tr>
						<th scope="row">
							<code>{row.name}</code>
						</th>
						<td className="layer-cell">{cell(row, null)}</td>
						{envs.map((env) => <td key={env.env} className="layer-cell">{cell(row, env.env)}</td>)}
					</tr>
					{after(row, 2 + envs.length)}
				</Fragment>
			))}
		</Table>
	)
}
