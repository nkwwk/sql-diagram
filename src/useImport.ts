import { useCallback, useEffect, useRef, useState } from 'react'
import type { ImportProgress, ImportResult, PasswordRequest } from './sql/import'
import type { WorkerRequest, WorkerResponse } from './sql/import.worker'

const STORAGE_KEY = 'sql-diagram:files'
/** Persist the extracted DDL (not the raw dumps) when it is reasonably small. */
const MAX_PERSIST_CHARS = 2_000_000

function fileKey(f: File) {
  return `${f.name}:${f.size}:${f.lastModified}`
}

function loadSaved(): File[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const saved = JSON.parse(raw) as { name: string; ddl: string }[]
    return saved.map((f) => new File([f.ddl], f.name, { type: 'text/plain' }))
  } catch {
    return []
  }
}

function save(result: ImportResult | null) {
  try {
    // Never write schemas decrypted from password-protected files to storage.
    if (!result || result.sensitive) {
      localStorage.removeItem(STORAGE_KEY)
      return
    }
    const total = result.ddl.reduce((n, d) => n + d.length, 0)
    if (total > MAX_PERSIST_CHARS) {
      localStorage.removeItem(STORAGE_KEY)
      return
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(result.files.map((f, i) => ({ name: f.name, ddl: result.ddl[i] }))))
  } catch {
    /* storage unavailable or full */
  }
}

let requestId = 0

/** Parses the current set of files in a Web Worker; a new set cancels the previous parse. */
export function useImport() {
  const [files, setFiles] = useState<File[]>(loadSaved)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(() => files.length > 0)
  const [passwordRequest, setPasswordRequest] = useState<(PasswordRequest & { requestId: number }) | null>(null)
  const firstRun = useRef(true)
  const active = useRef<{ worker: Worker; id: number } | null>(null)

  useEffect(() => {
    const restoring = firstRun.current
    firstRun.current = false
    if (!files.length) {
      if (!restoring) save(null)
      return
    }
    const id = ++requestId
    const worker = new Worker(new URL('./sql/import.worker.ts', import.meta.url), { type: 'module' })
    active.current = { worker, id }
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      if (msg.id !== id) return
      if (msg.type === 'progress') setProgress(msg.progress)
      else if (msg.type === 'password') setPasswordRequest({ ...msg.request, requestId: msg.requestId })
      else if (msg.type === 'done') {
        setResult(msg.result)
        setBusy(false)
        setProgress(null)
        worker.terminate()
        if (!restoring) save(msg.result)
      } else {
        setError(msg.message)
        setBusy(false)
        worker.terminate()
      }
    }
    worker.onerror = (e) => {
      setError(e.message || 'The parser crashed.')
      setBusy(false)
    }
    worker.postMessage({ type: 'import', id, files } satisfies WorkerRequest)
    return () => {
      worker.terminate()
      if (active.current?.worker === worker) active.current = null
    }
  }, [files])

  /** Answers the pending password prompt; null skips the archive's encrypted files. */
  const answerPassword = useCallback(
    (password: string | null) => {
      const current = active.current
      if (current && passwordRequest) {
        current.worker.postMessage({ type: 'password', id: current.id, requestId: passwordRequest.requestId, password } satisfies WorkerRequest)
      }
      setPasswordRequest(null)
    },
    [passwordRequest],
  )

  const update = useCallback((next: File[]) => {
    setFiles(next)
    setPasswordRequest(null)
    setBusy(next.length > 0)
    setProgress(null)
    setError(null)
    if (!next.length) setResult(null)
  }, [])

  const replaceFiles = useCallback((next: File[]) => update(next), [update])
  const addFiles = useCallback(
    (more: File[]) => {
      const seen = new Set(files.map(fileKey))
      const fresh = more.filter((f) => !seen.has(fileKey(f)))
      if (fresh.length) update([...files, ...fresh])
    },
    [files, update],
  )
  const removeFile = useCallback((index: number) => update(files.filter((_, i) => i !== index)), [files, update])

  return { files, result, progress, error, busy, replaceFiles, addFiles, removeFile, passwordRequest, answerPassword }
}
