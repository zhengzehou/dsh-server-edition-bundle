import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

export class JsonFileConfigStore {
  constructor(path) {
    this.path = path
    this.values = undefined
    this.writes = Promise.resolve()
  }

  async #load() {
    if (this.values) return this.values
    try {
      this.values = JSON.parse(await readFile(this.path, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      this.values = {}
    }
    return this.values
  }

  async get(section) {
    return clone((await this.#load())[section])
  }

  async set(section, value) {
    const values = await this.#load()
    values[section] = clone(value)
    this.writes = this.writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify(values, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.path)
    })
    await this.writes
    return clone(value)
  }
}
