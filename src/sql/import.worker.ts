import { importFiles, type ImportProgress, type ImportResult } from './import'

export type WorkerRequest = { id: number; files: File[] }
export type WorkerResponse =
  | { id: number; type: 'progress'; progress: ImportProgress }
  | { id: number; type: 'done'; result: ImportResult }
  | { id: number; type: 'error'; message: string }

const post = (msg: WorkerResponse) => self.postMessage(msg)

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { id, files } = e.data
  let last = 0
  try {
    const result = await importFiles(files, (progress) => {
      const now = performance.now()
      if (now - last < 80 && progress.loaded < progress.total) return
      last = now
      post({ id, type: 'progress', progress })
    })
    post({ id, type: 'done', result })
  } catch (err) {
    post({ id, type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
