export interface Column {
  name: string
  type: string
  nullable: boolean
  primaryKey: boolean
  unique: boolean
  autoIncrement: boolean
  defaultValue?: string
  comment?: string
}

export interface Table {
  /** Unique id; schema-qualified unless the schema is a default one (public, dbo, main). */
  id: string
  name: string
  schema?: string
  columns: Column[]
  primaryKey: string[]
  uniques: string[][]
  comment?: string
  /** Name of the file the table was defined in. */
  source?: string
  /** True when the table looks like a many-to-many link table. */
  isJunction: boolean
}

export type Cardinality = 'one-to-one' | 'many-to-one'

export interface Relationship {
  id: string
  name?: string
  /** Child table (holds the foreign key). */
  from: string
  fromColumns: string[]
  /** Parent table (referenced). */
  to: string
  toColumns: string[]
  cardinality: Cardinality
  /** The foreign key is nullable, so the parent is optional. */
  optional: boolean
  /** The foreign key is part of the child's primary key. */
  identifying: boolean
  onDelete?: string
  onUpdate?: string
}

export interface ManyToMany {
  via: string
  a: string
  b: string
}

export interface Schema {
  tables: Table[]
  relationships: Relationship[]
  manyToMany: ManyToMany[]
  warnings: string[]
}
