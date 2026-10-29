import {ARMS, hash} from './controller.mjs';

const labels = {'plugin-off': 'Standard Codex', cheap: 'Cheap retrieval', 'plugin-on': 'Codex + Jev'};
const terminal = slot => ['COMPLETE', 'INFRASTRUCTURE_INVALID'].includes(slot.status);
const total = (rows, get) => rows.reduce((sum, row) => sum + get(row), 0);
const knownTotal = (rows, get) => rows.length && rows.every(row => get(row) !== null && get(row) !== undefined) ? total(rows, get) : null;

export function summarizeStudy(state, asOf = state.lastAt) {
  if (!asOf && state.slots.some(slot => slot.startedAt)) throw new Error('An observed report time is required');
  const observedAt = asOf === null ? null : Date.parse(asOf);
  if (asOf !== null && (!Number.isFinite(observedAt) || state.lastAt && observedAt < Date.parse(state.lastAt))) throw new Error('Report time precedes retained observations');
  const duration = slot => slot.untrackedLaunch ? Date.parse(slot.untrackedLaunch.completedAt) - Date.parse(slot.untrackedLaunch.createdAt)
    : slot.startedAt === null ? 0 : Math.max(0, Date.parse(slot.endedAt ?? asOf) - Date.parse(slot.startedAt));
  const curves = {};
  const arms = ARMS.map(id => {
    const slots = state.slots.filter(slot => slot.arm === id);
    const assigned = slots.filter(slot => slot.startedAt !== null || slot.untrackedLaunch);
    const complete = slots.filter(slot => slot.status === 'COMPLETE');
    const advice = assigned.flatMap(slot => slot.consultations);
    let elapsed = 0, fixes = 0;
    const curve = [];
    for (const slot of assigned) {
      if (!terminal(slot)) break;
      if (!curve.length) curve.push({elapsedMs: 0, verifiedFixes: 0});
      elapsed += duration(slot);
      fixes += Number(slot.verdict === 'verified-fix' && slot.status === 'COMPLETE');
      curve.push({elapsedMs: elapsed, verifiedFixes: fixes});
    }
    curves[id] = complete.length ? curve : [];
    const verifiedFixes = complete.filter(slot => slot.verdict === 'verified-fix').length;
    const elapsedMs = total(assigned, duration);
    const elapsedTimeCoverage = assigned.some(slot => slot.untrackedLaunch) ? 'lower-bound' : 'complete';
    return {
      id, label: labels[id], assigned: assigned.length, completed: complete.length,
      pending: slots.filter(slot => !terminal(slot)).length, invalid: slots.filter(slot => slot.status === 'INFRASTRUCTURE_INVALID').length,
      verifiedFixes, fixRate: complete.length ? verifiedFixes / complete.length : null,
      verifiedFixBounds: {lower: verifiedFixes, upper: verifiedFixes + slots.filter(slot => slot.status !== 'COMPLETE').length},
      elapsedMs, elapsedLowerBoundMs:elapsedMs, elapsedTimeCoverage, observedTerminalElapsedMs: elapsed,
      timePerVerifiedFixMs: verifiedFixes && elapsedTimeCoverage === 'complete' ? elapsedMs / verifiedFixes : null,
      approvals: total(assigned, slot => slot.approvals), failedPublicCycles: total(assigned, slot => slot.failedPublicCycles),
      consultations: advice.length, providerRequests: advice.filter(row => row.providerInvoked === true).length,
      providerRequestUnknown: advice.filter(row => row.providerInvoked === null).length,
      consultationStatuses: Object.fromEntries(['assessed', 'abstained', 'unavailable', 'error'].map(status => [status, advice.filter(row => row.status === status).length])),
      adviceDelivered: advice.filter(row => row.delivered).length, uptakeObserved: advice.filter(row => row.uptake === 'observed').length,
      uptakeIgnored: advice.filter(row => row.uptake === 'ignored').length, uptakeUnknown: advice.filter(row => row.delivered && [null, 'unknown'].includes(row.uptake)).length,
      codingUsd: knownTotal(assigned, slot => slot.billing.codingUsd), jevUsd: knownTotal(assigned, slot => slot.billing.jevUsd),
      billingComplete: assigned.length > 0 && assigned.every(slot => slot.billing.complete),
      usage: Object.fromEntries(['inputTokens', 'outputTokens', 'cachedInputTokens'].map(key => [key, knownTotal(assigned, slot => slot.usage?.[key])])),
      usageObservedAttempts: assigned.filter(slot => slot.usage).length,
      packetDeliveries: assigned.filter(slot => slot.retrieval?.packetHash).length,
      packetMissing: id === 'cheap' ? assigned.filter(slot => !slot.retrieval?.packetHash).length : 0,
    };
  });
  const byId = Object.fromEntries(arms.map(arm => [arm.id, arm]));
  const on = byId['plugin-on'], off = byId['plugin-off'], cheap = byId.cheap;
  const complete = state.slots.every(slot => slot.status === 'COMPLETE') && !state.halted;
  const noFixLoss = on.verifiedFixes >= off.verifiedFixes && on.verifiedFixes >= cheap.verifiedFixes;
  const lowerTime = noFixLoss && on.timePerVerifiedFixMs !== null
    && [off, cheap].every(arm => arm.timePerVerifiedFixMs !== null && on.timePerVerifiedFixMs <= arm.timePerVerifiedFixMs * 0.8);
  const extraFix = on.verifiedFixes > cheap.verifiedFixes && on.verifiedFixes >= off.verifiedFixes;
  const approvalOkay = on.approvals <= off.approvals && on.approvals <= cheap.approvals;
  let verdict = 'inconclusive', reason = 'Pilot incomplete; pending attempts are not failures.';
  if (state.halted || state.slots.some(slot => slot.status === 'INFRASTRUCTURE_INVALID')) reason = 'Measurement integrity or infrastructure is unresolved; retain partial outcomes without a superiority claim.';
  else if (complete) {
    if (on.uptakeObserved > 0 && approvalOkay && (extraFix || lowerTime)) {
      verdict = 'helpful'; reason = 'Exploratory screen passed with observed advice use and no increased approval burden.';
    } else if (!noFixLoss || !approvalOkay) {
      verdict = 'harmful'; reason = 'Observed fix loss or increased approval interruptions; inspect advice context and uptake before a separately reviewed follow-up.';
    } else {
      verdict = 'neutral'; reason = 'No demonstrated advantage meeting the exploratory screen; six bugs cannot establish general superiority.';
    }
  }
  return {
    schemaVersion: 'whole-plugin-report-v1', studyId: /^[a-zA-Z0-9._-]{1,96}$/.test(state.manifest.studyId) ? state.manifest.studyId : `study-${hash(state.manifest.studyId).slice(0,16)}`,
    asOf, plannedAttempts: state.slots.length, completedAttempts: state.slots.filter(slot => slot.status === 'COMPLETE').length,
    pendingAttempts: state.slots.filter(slot => !terminal(slot)).length, invalidAttempts: state.slots.filter(slot => slot.status === 'INFRASTRUCTURE_INVALID').length,
    halted: Boolean(state.halted), arms,
    paired: state.manifest.tasks.map(task => ({taskId: task.id, conditions: Object.fromEntries(ARMS.map(id => {
      const slot = state.slots.find(row => row.taskId === task.id && row.arm === id);
      return [id, terminal(slot) ? slot.verdict ?? 'infrastructure-invalid' : 'pending'];
    }))})), curves, interpretation: {verdict, reason},
    limitations: ['Six-bug exploratory pilot, not an official full SWE-bench score.', 'Provider requests count observed invocations, not successful responses.',
      'Elapsed time includes all assigned attempts, startup, consultations, waits and grading; pending elapsed does not extend fix curves.',
      'Unknown billing stays unknown. Subscription capacity is not cash savings.',
      ...(arms.some(arm=>arm.elapsedTimeCoverage==='lower-bound') ? ['Elapsed time is a measured lower bound; pre-launch timing is unknown. The untracked native launch invalidated isolation and halted this study.'] : [])],
  };
}

const csvCell = value => value === null || value === undefined ? '' : `"${String(value).replaceAll('"', '""')}"`;
const csv = (columns, rows) => `${columns.join(',')}\n${rows.map(row => columns.map(key => csvCell(row[key])).join(',')).join('\n')}\n`;
export function exportCsv(report) {
  const columns = ['id','label','assigned','completed','pending','invalid','verifiedFixes','fixRate','elapsedMs','elapsedLowerBoundMs','elapsedTimeCoverage','timePerVerifiedFixMs','approvals','failedPublicCycles','consultations','providerRequests','providerRequestUnknown','adviceDelivered','uptakeObserved','uptakeIgnored','uptakeUnknown','codingUsd','jevUsd','billingComplete','inputTokens','outputTokens','cachedInputTokens','usageObservedAttempts','packetDeliveries','packetMissing'];
  return {
    'summary.csv': csv(columns, report.arms.map(arm => ({...arm, ...arm.usage}))),
    'paired.csv': csv(['taskId', ...ARMS], report.paired.map(row => ({taskId: row.taskId, ...row.conditions}))),
    'curves.csv': csv(['arm','elapsedMs','verifiedFixes'], ARMS.flatMap(arm => report.curves[arm].map(row => ({arm, ...row})))),
  };
}
