import { readFile, writeFile } from 'node:fs/promises'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js'

const stateFile = process.argv[2]
const failReconnectStarts = Number.parseInt(process.argv[3] ?? '0', 10) || 0
const listDelayMs = Number.parseInt(process.argv[4] ?? '0', 10) || 0
const includeRouterCollision = process.argv[5] === 'router-collision'
let catalog = 'initial'
let failNextList = false

async function incrementStarts() {
  if (!stateFile) return 1
  let starts = 0
  try { starts = Number.parseInt(await readFile(stateFile, 'utf8'), 10) || 0 } catch {}
  starts += 1
  await writeFile(stateFile, String(starts))
  return starts
}

const starts = await incrementStarts()
if (starts > 1 && starts <= failReconnectStarts + 1) process.exit(18)
const server = new Server(
  { name: 'dsh-mcp-lazy-fixture', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true } } }
)

const inputSchema = { type: 'object', properties: {}, additionalProperties: false }

function commands() {
  return [
    { name: 'echo', description: `echo-${catalog}`, inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false
    } },
    { name: 'change_catalog', description: 'change the fixture tool catalog', inputSchema },
    { name: 'fail_refresh', description: 'make the next tools/list request fail', inputSchema },
    { name: 'disconnect_once', description: 'close the first fixture process only', inputSchema },
    ...(includeRouterCollision
      ? [{ name: 'search_and_activate', description: 'native shared-router collision tool', inputSchema }]
      : [])
  ]
}

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  if (listDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, listDelayMs))
  if (failNextList) {
    failNextList = false
    throw new Error('fixture refresh failure')
  }
  const cursor = request.params?.cursor
  if (cursor === 'page-2') {
    return {
      tools: catalog === 'initial'
        ? [{ name: 'initial_only', description: 'removed after refresh', inputSchema }]
        : [{ name: 'changed_only', description: 'added after refresh', inputSchema }]
    }
  }
  return { tools: commands(), nextCursor: 'page-2' }
})

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  if (name === 'echo') {
    return { content: [{ type: 'text', text: String(args?.text ?? '') }] }
  }
  if (name === 'change_catalog') {
    catalog = 'changed'
    setTimeout(() => { void server.sendToolListChanged() }, 0)
    return { content: [{ type: 'text', text: 'catalog changed' }] }
  }
  if (name === 'fail_refresh') {
    failNextList = true
    setTimeout(() => { void server.sendToolListChanged() }, 0)
    return { content: [{ type: 'text', text: 'next refresh will fail' }] }
  }
  if (name === 'disconnect_once') {
    if (starts === 1) setTimeout(() => process.exit(17), 25)
    return { content: [{ type: 'text', text: starts === 1 ? 'disconnecting' : 'already reconnected' }] }
  }
  if (name === 'initial_only' || name === 'changed_only') {
    return { content: [{ type: 'text', text: name }] }
  }
  if (name === 'search_and_activate' && includeRouterCollision) {
    return { content: [{ type: 'text', text: 'native search_and_activate' }] }
  }
  throw new Error(`unknown fixture tool: ${name}`)
})

await server.connect(new StdioServerTransport())
