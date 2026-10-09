import type { FileReport } from '../sql/import'
import { formatBytes, formatCount } from '../util/format'

interface Props {
  files: File[]
  reports: FileReport[] | null
  onRemove: (index: number) => void
  onAdd: () => void
}

export default function FilesPanel({ files, reports, onRemove, onAdd }: Props) {
  return (
    <div className="files-panel">
      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th>File</th>
              <th className="num">Size</th>
              <th className="num">Tables</th>
              <th className="num">DDL statements</th>
              <th className="num">Data statements skipped</th>
              <th className="num">Parse time</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {files.map((f, i) => {
              const r = reports?.[i]
              const skipped = r ? r.inserts + r.copyBlocks : null
              return (
                <tr key={`${f.name}:${f.size}:${f.lastModified}:${i}`}>
                  <td className="mono strong">
                    {f.name}
                    {r && !r.skipped && r.encoding !== 'utf-8' && <span className="pill pill--soft">{r.encoding}</span>}
                    {r?.skipped && <span className="pill pill--warn" title={r.skipped}>skipped</span>}
                  </td>
                  <td className="num">{formatBytes(f.size)}</td>
                  <td className="num">{r ? formatCount(r.tables) : '…'}</td>
                  <td className="num">{r ? formatCount(r.kept) : '…'}</td>
                  <td className="num" title={r ? `${formatCount(r.inserts)} INSERT, ${formatCount(r.copyBlocks)} COPY blocks` : undefined}>
                    {skipped === null ? '…' : formatCount(skipped)}
                  </td>
                  <td className="num">{r ? `${r.ms < 1000 ? Math.round(r.ms) + ' ms' : (r.ms / 1000).toFixed(1) + ' s'}` : '…'}</td>
                  <td className="num">
                    <button className="ghost icon-btn" onClick={() => onRemove(i)} aria-label={`Remove ${f.name}`} title="Remove file">
                      ×
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        Tables from all files are merged into one schema; foreign keys may point across files.{' '}
        <button className="link-btn" onClick={onAdd}>Add more files</button>
      </p>
    </div>
  )
}
