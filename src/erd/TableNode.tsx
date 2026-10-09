import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { TableNodeType } from './layout'

function TableNode({ data }: NodeProps<TableNodeType>) {
  const { table, fkTargets, dim, active } = data
  return (
    <div className={`erd-table${dim ? ' is-dim' : ''}${active ? ' is-active' : ''}${table.isJunction ? ' is-junction' : ''}`}>
      <div className="erd-table__header" title={[table.id, table.comment, table.source && `Defined in ${table.source}`].filter(Boolean).join('\n')}>
        <span className="erd-table__name">{table.id}</span>
        {table.isJunction && <span className="erd-badge">link</span>}
      </div>
      {table.columns.length === 0 && <div className="erd-col erd-col--empty">no columns</div>}
      {table.columns.map((c) => {
        const ref = fkTargets[c.name.toLowerCase()]
        const tip = [
          `${c.name} ${c.type}`,
          c.primaryKey && 'Primary key',
          ref && `Foreign key → ${ref}`,
          c.unique && !c.primaryKey && 'Unique',
          c.nullable ? 'Nullable' : 'Not null',
          c.autoIncrement && 'Auto increment',
          c.defaultValue && `Default: ${c.defaultValue}`,
          c.comment,
        ]
          .filter(Boolean)
          .join('\n')
        return (
          <div key={c.name} className="erd-col" title={tip}>
            <Handle type="target" position={Position.Left} id={`${c.name}-l-t`} isConnectable={false} />
            <Handle type="source" position={Position.Left} id={`${c.name}-l-s`} isConnectable={false} />
            <span className="erd-col__keys">
              {c.primaryKey && <span className="key key--pk">PK</span>}
              {ref && <span className="key key--fk">FK</span>}
              {!c.primaryKey && !ref && c.unique && <span className="key key--uq">UQ</span>}
            </span>
            <span className={`erd-col__name${c.primaryKey ? ' is-pk' : ''}`}>{c.name}</span>
            <span className="erd-col__type">
              {c.type}
              {c.nullable && !c.primaryKey ? '?' : ''}
            </span>
            <Handle type="target" position={Position.Right} id={`${c.name}-r-t`} isConnectable={false} />
            <Handle type="source" position={Position.Right} id={`${c.name}-r-s`} isConnectable={false} />
          </div>
        )
      })}
    </div>
  )
}

export default memo(TableNode)
