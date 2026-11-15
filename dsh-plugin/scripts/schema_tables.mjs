/** Emit the table/column list from the generated schema, for the Python exporter. */
import { writeFileSync, mkdirSync } from 'node:fs'
import { TABLES } from '../src/store/schema.generated.ts'

const out = process.argv[2]
const payload = {
  tables: TABLES.map((table) => ({
    name: table.name,
    columns: table.columns.map((column) => ({
      name: column.name,
      kind: column.kind,
      notNull: column.notNull,
      primaryKey: column.primaryKey,
      json: column.json ?? false,
    })),
  })),
}
mkdirSync('.cache', { recursive: true })
writeFileSync(out, JSON.stringify(payload, null, 0))
console.log(`wrote ${out}: ${payload.tables.length} tables`)
