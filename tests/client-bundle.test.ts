/**
 * Smoke test for the built web client bundle (`lib/client.js`): with the dsh
 * loader mocked, the bundle must register under the package id and its factory
 * must return a Cordis plugin carrying `name` + `apply` — i.e. the web boot
 * would mount it. Requires `npm run build` to have produced lib/client.js.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const bundlePath = join(dirname(fileURLToPath(import.meta.url)), '../lib/client.js')

interface Loaded {
  id: string
  factory: (require: (id: string) => unknown) => unknown
}

describe('lib/client.js (built web client bundle)', () => {
  it.runIf(existsSync(bundlePath))('registers under the package id and yields a Cordis plugin', async () => {
    const captured: Loaded[] = []
    const windowBefore = (globalThis as { window?: unknown }).window
    ;(globalThis as { window?: unknown }).window = {
      __ModuleLoader__: {
        load: (spec: Loaded) => captured.push(spec),
      },
    }
    try {
      // @ts-expect-error -- built artifact (lib/client.js) has no declarations
      await import('../lib/client.js')
    } finally {
      if (windowBefore === undefined) delete (globalThis as { window?: unknown }).window
      else (globalThis as { window?: unknown }).window = windowBefore
    }
    expect(captured).toHaveLength(1)
    expect(captured[0]!.id).toBe('dsh-tool-hashline')
    const plugin = captured[0]!.factory(() => undefined) as { name?: string; apply?: unknown }
    expect(plugin.name).toBe('tool-hashline-client')
    expect(typeof plugin.apply).toBe('function')
  })
})
