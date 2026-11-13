// Assemble one render's metric values. `data` is the render's own copy of the payload: the
// rate-limit share below rewrites data.rate_limits. Returns the values, the folded session state
// and the time the advisor's god face ends, which the mugshot reads.

import { advisorInfo, godFlash, buildValues } from "./session.js";
import { activityValues } from "./activity.js";
import { tasksDir, readDiskTasks, mergeDiskTasks, loadState } from "./tasks.js";
import { sysValues } from "./system.js";
import { statsValues } from "./savings.js";
import { rateHealthValue, syncRateLimits } from "./ratelimits.js";

export function collectValues(data, env, now) {
  // Account-wide limits: use the freshest reading any session has seen (see syncRateLimits).
  // A brand-new chat that hasn't called the API yet gets them too. DOOMBAR_RATELIMITS_SHARE=0
  // turns it off.
  if (env.DOOMBAR_RATELIMITS_SHARE !== "0") {
    try { data.rate_limits = syncRateLimits(data.rate_limits, env); } catch { /* keep the session's own */ }
    if (!Object.keys(data.rate_limits || {}).length) delete data.rate_limits;
  }
  const st = mergeDiskTasks(loadState(data, env), readDiskTasks(tasksDir(data.session_id, env)));
  const cwd = data.cwd || (data.workspace || {}).current_dir;
  const values = {
    ...buildValues(data, st.git, now), ...activityValues(st, now), ...sysValues(cwd, now, env), ...statsValues(data, cwd, env),
  };
  const [advModel, advTs] = advisorInfo(data.transcript_path || "");
  if (advModel) values["advisor.model"] = advModel;
  const god_until = godFlash(data, advTs, now, env);
  // Rate-based mugshot health: when present, hpRow prefers it over the snapshot headroom.
  const headroom = rateHealthValue(data);
  if (headroom !== null) values["health.headroom"] = headroom;
  return { values, st, god_until };
}
