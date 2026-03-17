import { buildWorkspaceLite } from './insights'
import type { ParsedUpload } from '../types'

type WorkspaceWorkerRequest = {
  requestId: string
  uploads: ParsedUpload[]
}

self.onmessage = (event: MessageEvent<WorkspaceWorkerRequest>) => {
  const { requestId, uploads } = event.data

  try {
    const workspace = buildWorkspaceLite(uploads)
    self.postMessage({ requestId, workspace })
  } catch (error) {
    self.postMessage({
      requestId,
      error: error instanceof Error ? error.message : 'Workspace analysis failed.',
    })
  }
}
