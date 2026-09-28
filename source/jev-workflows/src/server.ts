import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { failureSchema, completionSchema } from './contracts.js';
import { createService } from './service.js';
import { dataDirectory, readBudgetUsage } from './store.js';
import { decisionSchema } from './decision.js';
import { evaluateDecisionsSchema } from './batch.js';
import { readPolicy, configurePolicy, automationPolicySchema } from './policy.js';
import { readEvaluationUsage } from './accounting.js';
import { updateTaskContextInputSchema, updateTaskContext } from './task-context.js';
import { decisionOutcomeSchema, recordDecisionOutcome } from './outcomes.js';

const service = createService();
const server = new Server({name: 'jev-workflows', version: '0.5.0'}, {capabilities: {tools: {}}});
server.setRequestHandler(ListToolsRequestSchema, async () => ({tools: [
  {name: 'jev_status', description: 'Read local Jev plugin readiness and limits. Does not contact TypeSafe or expose credentials.', inputSchema: {type: 'object', properties: {}, additionalProperties: false}, annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: false}},
  {name: 'classify_failure', description: 'Preview selected redacted command evidence locally, or evaluate an authorized payload with TypeSafe Jev. Evaluate sends data externally in a billable provider API request. Advisory failure classification; never edits files, approves permissions, or certifies a fix.', inputSchema: z.toJSONSchema(failureSchema, {io: 'input'}) as any, annotations: {readOnlyHint: false, destructiveHint: false, openWorldHint: true}},
  {name: 'check_completion', description: 'Preview a completion claim and selected evidence locally, or evaluate an authorized payload with TypeSafe Jev. Returns support, partial support, contradiction, or insufficient evidence. Advisory assessment, not a substitute for independent tests or user acceptance.', inputSchema: z.toJSONSchema(completionSchema, {io: 'input'}) as any, annotations: {readOnlyHint: false, destructiveHint: false, openWorldHint: true}},
  {name: 'classify_decision', description: 'Consult Jev for any classification or choice: tools, models and effort, tasks/delegation, skills, context, strategy, outcomes, or a caller-defined taxonomy. Supply the actual available candidates, question, evidence, and context containing the objective and constraints. Preview is local; evaluate sends a bounded redacted payload to TypeSafe. Returns a validated candidate ID or abstention, never permission or proof of execution. Use before consequential choices when the user has enabled Jev consultation.', inputSchema: z.toJSONSchema(decisionSchema, {io: 'input'}) as any, annotations: {readOnlyHint: false, destructiveHint: false, openWorldHint: true}},
  {name: 'configure_automation', description: 'Configure optional local evaluation caps and enable, scope, or disable automatic Jev lifecycle consultation for this local installation when the user requests it. There are no plugin-imposed daily call, byte-volume, or per-session caps by default; null leaves each optional cap unlimited, and only explicit user settings add caps. Replaces the previously saved local policy; the prior policy is not retained. Stores only local policy, never credentials. Enabled hooks send bounded redacted event context through the TypeSafe provider API. Hook trust remains a separate host control.', inputSchema: z.toJSONSchema(automationPolicySchema, {io: 'input'}) as any, annotations: {readOnlyHint: false, destructiveHint: true, openWorldHint: false}},
  {name: 'evaluate_decisions', description: 'Preview or evaluate independent typed Choice, Noul, and Score questions together against one selected structured state. Supply actual available candidates and explicit criteria. Evaluation sends redacted inputs to TypeSafe; probabilities and local per-question dispositions remain advisory. Batch only independent questions and combine answers in code. Never supplies authority, tool arguments, or proof of completion.', inputSchema: z.toJSONSchema(evaluateDecisionsSchema, {io: 'input'}) as any, annotations: {readOnlyHint: false, destructiveHint: false, openWorldHint: true}},
  {name: 'update_task_context', description: 'Update redacted local task context scoped to the actual workspace, session, and agent. Continue preserves the root objective; replace starts a new objective; reset clears the scoped context. Supply current constraints, acceptance criteria, corrections, evidence references, and actual candidate catalogs. Local only; replaces prior scoped context on replace/reset and does not change Codex settings or permissions.', inputSchema: z.toJSONSchema(updateTaskContextInputSchema, {io: 'input'}) as any, annotations: {readOnlyHint: false, destructiveHint: true, openWorldHint: false}},
  {name: 'record_decision_outcome', description: 'Append a local observation linked to an existing decision receipt, actual action, and evidence identifiers. This records what the caller reports happened; it never establishes independent verification, provider billing, or permission and never transmits evidence to TypeSafe.', inputSchema: z.toJSONSchema(decisionOutcomeSchema, {io: 'input'}) as any, annotations: {readOnlyHint: false, destructiveHint: false, openWorldHint: false}}
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
  else if (request.params.name === 'evaluate_decisions') result = await service.evaluateDecisions(request.params.arguments, extra.signal);
  else if (request.params.name === 'update_task_context') {
    const input = updateTaskContextInputSchema.parse(request.params.arguments);
    const context = await updateTaskContext(input.scope, input.update);
    result = context ? {status: 'updated', context} : {status: 'unavailable', reasonCode: 'task_context_unavailable'};
  }
  else if (request.params.name === 'record_decision_outcome') result = await recordDecisionOutcome(request.params.arguments);
  else if (request.params.name === 'configure_automation') result = await configurePolicy(request.params.arguments);
  else throw new Error('Unknown tool');
  return {content: [{type: 'text', text: JSON.stringify(result)}], structuredContent: result as Record<string, unknown>};
});
await server.connect(new StdioServerTransport());
