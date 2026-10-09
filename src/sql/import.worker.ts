import { importFiles, type ImportProgress, type ImportResult, type PasswordRequest } from './import'

export type WorkerRequest =
  | { type: 'import'; id: number; files: File[] }
  /** Reply to a password request; null skips the archive's encrypted files. */
  | { type: 'password'; id: number; requestId: number; password: string | null }

export type WorkerResponse =
  | { id: number; type: 'progress'; progress: ImportProgress }
  | { id: number; type: 'password'; requestId: number; request: PasswordRequest }
  | { id: number; type: 'done'; result: ImportResult }
  | { id: number; type: 'error'; message: string }

const post = (msg: WorkerResponse) => self.postMessage(msg)
const pendingPasswords = new Map<number, (password: string | null) => void>()
let nextRequestId = 0

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  if (msg.type === 'password') {
    pendingPasswords.get(msg.requestId)?.(msg.password)
    pendingPasswords.delete(msg.requestId)
    return
  }

  const { id, files } = msg
  let last = 0
  const askPassword = (request: PasswordRequest) =>
    new Promise<string | null>((resolve) => {
      const requestId = ++nextRequestId
      pendingPasswords.set(requestId, resolve)
      post({ id, type: 'password', requestId, request })
    })
  try {
    const result = await importFiles(
      files,
      (progress) => {
        const now = performance.now()
        if (now - last < 80 && progress.loaded < progress.total) return
        last = now
        post({ id, type: 'progress', progress })
      },
      askPassword,
    )
    post({ id, type: 'done', result })
  } catch (err) {
    post({ id, type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
