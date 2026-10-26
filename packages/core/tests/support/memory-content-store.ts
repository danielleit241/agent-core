import { contentHash } from '../../src/content/snapshot'
import type { ContentStore } from '../../src/ports'

/** An in-memory content store. `puts` counts the texts actually inserted (not the ones already there). */
export class MemoryContentStore implements ContentStore {
  readonly blobs = new Map<string, string>()
  puts = 0
  async put(texts: string[]): Promise<string[]> {
    return texts.map((text) => {
      const hash = contentHash(text)
      if (!this.blobs.has(hash)) {
        this.blobs.set(hash, text)
        this.puts++
      }
      return hash
    })
  }
  async get(hashes: string[]): Promise<Map<string, string>> {
    return new Map(hashes.flatMap((h) => (this.blobs.has(h) ? [[h, this.blobs.get(h)!] as const] : [])))
  }
}
