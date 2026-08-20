import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'))
const bundlePatch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

test('package metadata publishes the installable bundle from the npm owner scope', () => {
  assert.equal(pkg.name, '@yilinxiao/dsh-mcp-lazy')
  assert.equal(pkg.version, '0.5.1')
  assert.equal(lock.version, '0.5.1')
  assert.equal(lock.packages[''].version, '0.5.1')
  assert.equal(pkg.repository.url, 'git+https://github.com/leaforbook/dsh-mcp-lazy.git')
  assert.equal(pkg.homepage, 'https://github.com/leaforbook/dsh-mcp-lazy#readme')
  assert.equal(pkg.bugs.url, 'https://github.com/leaforbook/dsh-mcp-lazy/issues')
  assert.deepEqual(pkg.publishConfig, { access: 'public' })
  assert.deepEqual(pkg.dsh, { bundle: { patch: './cordis.patch.yml' } })
  assert.ok(pkg.files.includes('cordis.patch.yml'))
  assert.match(bundlePatch, /name: '@yilinxiao\/dsh-mcp-lazy'/)
})

test('package discovery metadata exposes the MCP token-saving use case', () => {
  assert.match(pkg.description, /MCP lazy-loading/i)
  assert.match(pkg.description, /context bloat/i)
  assert.match(pkg.description, /save tokens/i)
  assert.match(pkg.description, /progressive disclosure/i)
  for (const keyword of [
    'token-saving',
    'token-savings',
    'context-optimization',
    'tool-schema',
    'tool-router',
    'mcp-router',
    'on-demand-tools',
    'progressive-disclosure',
  ]) {
    assert.ok(pkg.keywords.includes(keyword), `missing npm discovery keyword: ${keyword}`)
  }
})
