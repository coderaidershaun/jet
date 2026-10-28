// Keeps a finished job card up to date after the model's reply has ended. A tool that starts a job
// says, in the marker `_meta["jet/job"]`, which read-only tool reports on it. The page asks that
// tool through Jet every few seconds until the job is no longer running. Everything the tool
// returns is data, and a failure only ever stops the watching, never the page.

import { randomId } from '../../../bridge/browser-agent.js';
import { callState } from './model.js';
import { RUNNING, isJob, jobOf } from './job.js';
import { isRecord, orNull, recordOf } from './guard.js';

const APP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FAILURES_IN_A_ROW = 3;

/** The job the tool reports, whether the status tool gave it as structured content or as JSON text. */
function jobIn(result) {
  const answer = recordOf(result);
  if (answer.isError === true) return null;
  if (isJob(answer.structuredContent)) return answer.structuredContent;
  for (const block of Array.isArray(answer.content) ? answer.content : []) {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') continue;
    try {
      const parsed = JSON.parse(block.text);
      if (isJob(parsed)) return parsed;
    } catch {
      // Text that is not JSON is not a job.
    }
  }
  return null;
}

/**
 * @param {{
 *   request: (path: string, body?: object) => Promise<any>,
 *   setTimeout?: (run: () => void, ms: number) => any,
 *   clearTimeout?: (timer: any) => void,
 *   intervalMs?: number,
 *   newId?: () => string,
 * }} options
 *   `request` has the shape of `requestJson`: a GET with no body, else a POST.
 */
export function createJobWatcher({
  request,
  setTimeout: later = (run, ms) => globalThis.setTimeout(run, ms),
  clearTimeout: cancelTimer = (timer) => globalThis.clearTimeout(timer),
  intervalMs = 5000,
  newId = randomId,
}) {
  /** @type {Map<string, Promise<any>>} */
  const catalogues = new Map();

  function catalogueOf(appId) {
    if (!catalogues.has(appId)) {
      const loading = request('/api/apps/' + encodeURIComponent(appId) + '/tools');
      // A catalogue that failed to load is asked for again by the next watch.
      loading.catch(() => catalogues.delete(appId));
      catalogues.set(appId, loading);
    }
    return catalogues.get(appId);
  }

  /** The status tool, the name of its id field and the job's id, or null when the call does not declare a job. */
  async function targetOf(call) {
    const catalogue = recordOf(await catalogueOf(call.server));
    const tool = (Array.isArray(catalogue.tools) ? catalogue.tools : []).map(recordOf).find((candidate) => candidate.name === call.tool);
    const marker = recordOf(recordOf(tool?._meta)['jet/job']);
    const statusTool = orNull(marker.statusTool);
    const idField = orNull(marker.idField);
    const jobId = idField && orNull(recordOf(call.result)[idField]);
    return marker.version === 1 && statusTool && idField && jobId ? { statusTool, idField, jobId } : null;
  }

  return {
    /**
     * Starts watching the job a finished call began. `onJob` hears each report. The watching ends by
     * itself when the job is no longer running; the returned function ends it sooner.
     * @param {import('./model.js').ShownCall} call
     * @param {(job: object) => void} onJob
     * @returns {() => void}
     */
    watch(call, onJob) {
      let stopped = false;
      let timer = null;
      let inFlight = null;
      let failures = 0;

      const stop = () => {
        stopped = true;
        if (timer !== null) cancelTimer(timer);
        timer = null;
        if (inFlight !== null) request('/api/tools/cancel', { requestId: inFlight }).catch(() => {});
        inFlight = null;
      };

      async function poll(target) {
        timer = null;
        const requestId = newId();
        inFlight = requestId;
        let job = null;
        try {
          const answer = await request('/api/apps/' + encodeURIComponent(call.server) + '/status', {
            requestId,
            tool: target.statusTool,
            arguments: { [target.idField]: target.jobId },
          });
          job = jobIn(recordOf(answer).result);
        } catch {
          job = null;
        }
        if (stopped) return;
        inFlight = null;
        failures = job ? 0 : failures + 1;
        if (job) onJob(job);
        if (job && job.state !== RUNNING) return;
        if (failures < FAILURES_IN_A_ROW) timer = later(() => poll(target), intervalMs);
      }

      async function begin() {
        if (!APP_ID.test(String(call.server)) || callState(call) !== 'done' || jobOf(call.result)?.state !== RUNNING) return;
        let target = null;
        try {
          target = await targetOf(call);
        } catch {
          return;
        }
        if (stopped || !target) return;
        timer = later(() => poll(target), intervalMs);
      }

      begin();
      return stop;
    },
  };
}
