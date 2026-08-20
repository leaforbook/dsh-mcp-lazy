import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
const bundlePatch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

test('README installs the package from the npm owner scope', () => {
  assert.match(readme, /dsh plugin --profile web add @yilinxiao\/dsh-mcp-lazy/)
  assert.doesNotMatch(readme, /github:leaforbook\/dsh-mcp-lazy/)
  assert.doesNotMatch(readme, /@xiaoyilin\/dsh-mcp-lazy/)
})

test('bundle enables exactly one universal manager entry', () => {
  assert.equal([...bundlePatch.matchAll(/^    - id:/gm)].length, 1)
  assert.match(bundlePatch, /^    - id: mcp-lazy-manager\n      name: '@yilinxiao\/dsh-mcp-lazy'\n      config:\n        mode: manager$/m)
  assert.doesNotMatch(bundlePatch, /^\s*disabled:/m)
})

test('README explains universal takeover boundaries and safe opt-out', () => {
  for (const text of [
    '0.5.0',
    'mode: manager',
    'mcp-lazy-manager',
    '兼容性准入',
    '不兼容的 MCP 保持原样',
    'fail-open',
    'Schema 按需披露',
    '连接层懒加载',
    '0.1.0-rc.6、0.1.0-rc.7 和 0.1.0-rc.8'
  ]) assert.match(readme, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(readme, /\| 显式 `dsh-mcp-lazy` server \|/)
  assert.match(readme, /\| 通过兼容性准入的其他 DSH MCP \|/)
  assert.match(readme, /\| 不兼容或无法确认的 MCP \|/)
  assert.match(readme, /\$DSH_HOME\/profiles\/web\/cordis\.patch\.yml/)
  assert.match(readme, /- id: mcp-lazy-manager\n  disabled: true/)
  assert.match(readme, /只禁用 manager 条目即可/)
  assert.match(readme, /显式 lazy server 配置不会受影响/)
  assert.doesNotMatch(readme, /dsh plugin --profile web (?:disable|remove) mcp-lazy-manager/)
  assert.doesNotMatch(readme, /移除或禁用 id 为 `mcp-lazy-manager`/)
  assert.match(readme, /mcp__router__search_and_activate/)
})
