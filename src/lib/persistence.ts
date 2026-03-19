import type { AIResult, ParsedUpload } from '../types'

const DB_NAME = 'export-viewer-pro'
const DB_VERSION = 1
const SNAPSHOT_STORE = 'snapshots'
const SNAPSHOT_KEY = 'workspace'

export type PersistedSnapshot = {
  uploads: ParsedUpload[]
  contactAiResults: Record<string, AIResult>
  reviewLaterContacts: string[]
  savedAt: string
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => reject(new Error('IndexedDB could not be opened on this browser.'))
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(SNAPSHOT_STORE)) {
        database.createObjectStore(SNAPSHOT_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
  })
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason?: unknown) => void) => void,
) {
  const database = await openDatabase()

  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(SNAPSHOT_STORE, mode)
    const store = transaction.objectStore(SNAPSHOT_STORE)

    transaction.oncomplete = () => database.close()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'))

    run(store, resolve, reject)
  })
}

export async function loadSnapshot(key = SNAPSHOT_KEY) {
  return withStore<PersistedSnapshot | null>('readonly', (store, resolve, reject) => {
    const request = store.get(key)
    request.onerror = () => reject(new Error('Saved workspace could not be read.'))
    request.onsuccess = () => resolve((request.result as PersistedSnapshot | undefined) ?? null)
  })
}

export async function saveSnapshot(snapshot: PersistedSnapshot, key = SNAPSHOT_KEY) {
  return withStore<void>('readwrite', (store, resolve, reject) => {
    const request = store.put(snapshot, key)
    request.onerror = () => reject(new Error('Saved workspace could not be updated.'))
    request.onsuccess = () => resolve()
  })
}

export async function clearSnapshot(key = SNAPSHOT_KEY) {
  return withStore<void>('readwrite', (store, resolve, reject) => {
    const request = store.delete(key)
    request.onerror = () => reject(new Error('Saved workspace could not be cleared.'))
    request.onsuccess = () => resolve()
  })
}
