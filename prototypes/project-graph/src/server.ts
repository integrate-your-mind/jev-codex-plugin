import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema, ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {ProjectGraphRuntime} from './runtime.js';

const runtime = await ProjectGraphRuntime.fromEnvironment();
const server = new Server({name: 'project-graph', version: '0.1.0'}, {capabilities: {tools: {}}});

server.setRequestHandler(ListToolsRequestSchema, async () => ({tools: [{
  name: 'project_graph',
  description: 'Search, expand, or read the current TypeScript project graph. Results contain source cards and graph identities only.',
  inputSchema: {
    type: 'object',
    properties: {
      operation: {type: 'string', enum: ['search', 'expand', 'read']},
      query: {type: 'string', maxLength: 4000},
      nodeId: {type: 'string'},
      cursor: {type: 'string'},
    },
    required: ['operation'],
    additionalProperties: false,
  },
  annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: false},
}]}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if (request.params.name !== 'project_graph') throw new Error('Unknown tool');
  const result = await runtime.execute(request.params.arguments, extra.signal);
  return {content: [{type: 'text', text: JSON.stringify(result)}], structuredContent: result as unknown as Record<string, unknown>};
});

const transport = new StdioServerTransport();
const send = transport.send.bind(transport);
transport.send = async message => {
  await send(message);
  if ('result' in message && message.result && typeof message.result === 'object') {
    const structured = (message.result as {structuredContent?: unknown}).structuredContent;
    if (structured && typeof structured === 'object' && 'packetHash' in structured) await runtime.recordToolOutput(structured as never);
  }
};
await server.connect(transport);
