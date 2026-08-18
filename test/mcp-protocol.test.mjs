import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  ToolListChangedNotificationSchema
} from '@modelcontextprotocol/sdk/types.js'

import { discoverTools } from '../lib/lazy-core.js'

const fixture = fileURLToPath(new URL('./fixtures/dynamic-mcp-server.mjs', import.meta.url))

test('the real MCP fixture supports pagination, calls, and list-change notifications', async (context) => {
  const client = new Client({ name: 'dsh-mcp-lazy-test', version: '1.0.0' }, { capabilities: {} })
  context.after(async () => { try { await client.close() } catch {} })

  let changed
  const changedSignal = new Promise((resolve) => { changed = resolve })
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => changed())
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fixture] }), { timeout: 5000 })

  const initial = await discoverTools({
    request: client.request.bind(client),
    resultSchema: ListToolsResultSchema,
    timeoutMs: 5000,
    maxPages: 10
  })
  assert.deepEqual(initial.map((entry) => entry.name), [
    'echo', 'change_catalog', 'fail_refresh', 'disconnect_once', 'initial_only'
  ])

  const echo = await client.request({
    method: 'tools/call',
    params: { name: 'echo', arguments: { text: 'fixture-ok' } }
  }, CallToolResultSchema, { timeout: 5000 })
  assert.equal(echo.content[0].text, 'fixture-ok')

  await client.request({
    method: 'tools/call',
    params: { name: 'change_catalog', arguments: {} }
  }, CallToolResultSchema, { timeout: 5000 })
  let notificationTimeout
  try {
    await Promise.race([
      changedSignal,
      new Promise((_, reject) => {
        notificationTimeout = setTimeout(() => reject(new Error('list-change notification timed out')), 5000)
      })
    ])
  } finally {
    clearTimeout(notificationTimeout)
  }

  const refreshed = await discoverTools({
    request: client.request.bind(client),
    resultSchema: ListToolsResultSchema,
    timeoutMs: 5000,
    maxPages: 10
  })
  assert.equal(refreshed.find((entry) => entry.name === 'echo').description, 'echo-changed')
  assert.ok(refreshed.some((entry) => entry.name === 'changed_only'))
  assert.ok(!refreshed.some((entry) => entry.name === 'initial_only'))
})
