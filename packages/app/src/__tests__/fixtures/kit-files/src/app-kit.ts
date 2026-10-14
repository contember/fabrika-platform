import { defineApp } from '@fabrika/app/contract'
import { tables } from '../../scoped-files/src/db/tables'
import { vocabulary } from '../../scoped-files/src/vocabulary'

export const app = defineApp(vocabulary, tables)
