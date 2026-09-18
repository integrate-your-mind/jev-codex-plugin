import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { failureSchema, completionSchema } from './contracts.js';
import { createService } from './service.js';
import { dataDirectory, readBudgetUsage } from './store.js';
import { decisionSchema } from './decision.js';
import { readPolicy, configurePolicy, automationPolicySchema } from './policy.js';
import { readEvaluationUsage } from './accounting.js';

const service = createService();
const server = new Server({name: 'jev-workflows', version: '0.2.0'}, {capabilities: {tools: {}}});
server.setRequestHandler(ListToolsRequestSchema, async () => ({tools: [
  {name: 'jev_status', description: 'Read local Jev plugin readiness and limits. Does not contact TypeSafe or expose credentials.', inputSchema: {type: 'object', properties: {}, additionalProperties: false}, annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: false}},
  {name: 'classify_failure', description: 'Preview selected redacted command evidence locally, or evaluate an authorized payload with TypeSafe Jev. Evaluate sends data externally in a billable provider API request. Advisory failure classification; never edits files, approves permissions, or certifies a fix.', inputSchema: z.toJSONSchema(failureSchema, {io: 'input'}) as any, annotations: {readOnlyHint: false, destructiveHint: false, openWorldHint: true}},
  {name: 'check_completion', description: 'Preview a completion claim and selected evidence locally, or evaluate an authorized payload with TypeSafe Jev. Returns support, partial support, contradiction, or insufficient evidence. Advisory assessment, not a substitute for independent tests or user acceptance.', inputSchema: z.toJSONSchema(completionSchema, {io: 'input'}) as any, annotations: {readOnlyHint: false, destructiveHint: false, openWorldHint: true}},
  {name: 'classify_decision', description: 'Consult Jev for any classification or choice: tools, models and effort, tasks/delegation, skills, context, strategy, outcomes, or a caller-defined taxonomy. Supply the actual available candidates, question, evidence, and context containing the objective and constraints. Preview is local; evaluate sends a bounded redacted payload to TypeSafe. Returns a validated candidate ID or abstention, never permission or proof of execution. Use before consequential choices when the user has enabled Jev consultation.', inputSchema: z.toJSONSchema(decisionSchema, {io: 'input'}) as any, annotations: {readOnlyHint: false, destructiveHint: false, openWorldHint: true}},
  {name: 'configure_automation', description: 'Configure optional local evaluation caps and enable, scope, or disable automatic Jev lifecycle consultation for this local installation when the user requests it. There are no plugin-imposed daily call, byte-volume, or per-session caps by default; null leaves each optional cap unlimited, and only explicit user settings add caps. Stores only local policy, never credentials. Enabled hooks send bounded redacted event context through the TypeSafe provider API. Hook trust remains a separate host control.', inputSchema: z.toJSONSchema(automationPolicySchema, {io: 'input'}) as any, annotations: {readOnlyHint: false, destructiveHint: false, openWorldHint: false}}
]}));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  let result: unknown;
  if (request.params.name === 'jev_status') {
    if (Object.keys(request.params.arguments ?? {}).length) throw new Error('jev_status accepts no arguments');
    const automation = await readPolicy();
    const status = service.status(automation);
    const [budget, evaluations] = await Promise.all([
      readBudgetUsage(dataDirectory(), status.maxCallsPerDay, status.maxBytesPerDay),
      readEvaluationUsage(dataDirectory(), status.credentialFingerprint),
    ]);
    result = {...status, automation, budget, evaluations};
  } else if (request.params.name === 'classify_failure') result = await service.classifyFailure(request.params.arguments, extra.signal);
  else if (request.params.name === 'check_completion') result = await service.checkCompletion(request.params.arguments, extra.signal);
  else if (request.params.name === 'classify_decision') result = await service.classifyDecision(request.params.arguments, extra.signal);
  else if (request.params.name === 'configure_automation') result = await configurePolicy(request.params.arguments);
  else throw new Error('Unknown tool');
  return {content: [{type: 'text', text: JSON.stringify(result)}], structuredContent: result as Record<string, unknown>};
});
await server.connect(new StdioServerTransport());
