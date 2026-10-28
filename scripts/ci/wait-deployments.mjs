// Wait for Vercel's deployments of one commit and fail unless every one
// succeeded. Vercel reports each build to GitHub as a deployment with
// statuses, readable with the workflow's own GITHUB_TOKEN: no Vercel token is
// involved. A failed share deployment went unnoticed for four pushes
// (2026-10-27 to 10-28); a failed run of this script emails the pusher.
//
// Usage: node scripts/ci/wait-deployments.mjs <owner/repo> <sha> <environment>...
// Each named environment must reach a final status within the time limit.
const [repo, sha, ...environments] = process.argv.slice(2);
if (!repo || !sha || environments.length === 0) {
  throw new Error('Usage: wait-deployments.mjs <owner/repo> <sha> <environment>...');
}
const token = process.env.GITHUB_TOKEN;
const LIMIT_MS = 15 * 60_000;
const POLL_MS = 20_000;

async function get(path) {
  const res = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
    headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) throw new Error(`GitHub ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

// The latest status of the newest deployment for each environment, or
// 'missing' when Vercel has not created one yet.
async function states() {
  const deployments = await get(`deployments?sha=${sha}&per_page=100`);
  const out = {};
  for (const env of environments) {
    const newest = deployments.find((d) => d.environment === env);
    if (!newest) {
      out[env] = { state: 'missing' };
      continue;
    }
    const [status] = await get(`deployments/${newest.id}/statuses?per_page=1`);
    out[env] = { state: status?.state ?? 'pending', description: status?.description ?? '' };
  }
  return out;
}

const FINAL = new Set(['success', 'failure', 'error', 'inactive']);
const started = Date.now();
let last = {};
while (Date.now() - started < LIMIT_MS) {
  last = await states();
  if (Object.values(last).every((s) => FINAL.has(s.state))) break;
  await new Promise((r) => setTimeout(r, POLL_MS));
}

let failed = false;
for (const env of environments) {
  const s = last[env] ?? { state: 'missing' };
  // Vercel marks a deployment inactive once a later one replaces it, after
  // it succeeded.
  const ok = s.state === 'success' || s.state === 'inactive';
  if (!ok) failed = true;
  const why = FINAL.has(s.state) ? s.description : `no final status within ${LIMIT_MS / 60_000} minutes (${s.state})`;
  console.log(`${ok ? 'ok    ' : 'FAILED'} ${env}: ${ok ? 'deployed' : why}`);
}
if (failed) process.exit(1);
