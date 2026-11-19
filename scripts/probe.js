// Tries each GitHub call the review bot makes, with whatever token GH_TOKEN holds, and prints
// one line per call: OK or the error. Never throws. Usage: node probe.js <owner/repo> <pr> <steps>
// steps: comma list of read,label,review,reply,read-thread,resolve,resolve-human,delete-pending,approve,approve-rest,decision
const [repo, pr, stepsArg = 'all'] = process.argv.slice(2);
const token = process.env.GH_TOKEN;
const API = 'https://api.github.com';
const [owner, name] = repo.split('/');

async function call(method, path, body) {
  const res = await fetch(`${API}/${path}`, {
    method,
    headers: {Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
async function gql(query, variables) {
  const data = await call('POST', 'graphql', {query, variables});
  if (data.errors?.length) throw new Error(`GraphQL ${data.errors.map((e) => `${e.type || ''}: ${e.message}`).join('; ')}`);
  return data.data;
}

const state = {};
const results = [];
async function step(label, fn) {
  try {
    const out = await fn();
    results.push(`OK    ${label}${out ? ` (${out})` : ''}`);
  } catch (err) {
    results.push(`FAIL  ${label}: ${err.message}`);
  }
}

const STEPS = {
  read: async () => {
    const p = await call('GET', `repos/${repo}/pulls/${pr}`);
    state.pull = p;
    await call('GET', `repos/${repo}/pulls/${pr}/files?per_page=100`);
    await call('GET', `repos/${repo}/pulls/${pr}/reviews?per_page=100`);
    await call('GET', `repos/${repo}/pulls/${pr}/comments?per_page=100`);
    await call('GET', `repos/${repo}/compare/${p.base.sha}...${p.head.sha}`);
    await call('GET', `repos/${repo}/commits/${p.head.sha}`);
    await call('GET', `repos/${repo}/contents/README.md?ref=${p.base.sha}`);
    await call('GET', `repos/${repo}/labels?per_page=100`);
    await call('GET', `repos/${repo}/issues/${pr}/events?per_page=100`);
    return `head ${p.head.sha.slice(0, 7)}`;
  },
  label: async () => {
    await call('POST', `repos/${repo}/issues/${pr}/labels`, {labels: ['spike-label']});
  },
  review: async () => {
    const created = await gql('mutation($prId:ID!){addPullRequestReview(input:{pullRequestId:$prId}){pullRequestReview{id}}}', {prId: state.pull.node_id});
    const rId = created.addPullRequestReview.pullRequestReview.id;
    const t = await gql(
      'mutation($rId:ID!,$path:String!,$body:String!){addPullRequestReviewThread(input:{pullRequestReviewId:$rId,path:$path,line:1,side:RIGHT,subjectType:LINE,body:$body}){thread{id comments(first:1){nodes{databaseId}}}}}',
      {rId, path: 'change.txt', body: `probe thread ${new Date().toISOString()}`}
    );
    state.threadId = t.addPullRequestReviewThread.thread.id;
    state.commentId = t.addPullRequestReviewThread.thread.comments.nodes[0].databaseId;
    await gql('mutation($rId:ID!){submitPullRequestReview(input:{pullRequestReviewId:$rId,event:COMMENT,body:"probe review"}){pullRequestReview{state}}}', {rId});
    return `thread ${state.threadId}`;
  },
  reply: async () => {
    await call('POST', `repos/${repo}/pulls/${pr}/comments/${state.commentId}/replies`, {body: 'probe reply'});
  },
  'read-thread': async () => {
    const d = await gql('query($id:ID!){node(id:$id){... on PullRequestReviewThread{isResolved comments{totalCount}}}}', {id: state.threadId});
    return JSON.stringify(d.node);
  },
  resolve: async () => {
    const d = await gql('mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}', {id: state.threadId});
    return `isResolved=${d.resolveReviewThread.thread.isResolved}`;
  },
  'resolve-human': async () => {
    const d = await gql(
      `query{repository(owner:"${owner}",name:"${name}"){pullRequest(number:${pr}){reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{author{login}}}}}}}}`
    );
    const human = d.repository.pullRequest.reviewThreads.nodes.find((t) => !t.isResolved && t.comments.nodes[0]?.author?.login === owner);
    if (!human) return 'no open human thread; skipped';
    const r = await gql('mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}', {id: human.id});
    return `isResolved=${r.resolveReviewThread.thread.isResolved}`;
  },
  'delete-pending': async () => {
    const created = await gql('mutation($prId:ID!){addPullRequestReview(input:{pullRequestId:$prId}){pullRequestReview{id}}}', {prId: state.pull.node_id});
    const rId = created.addPullRequestReview.pullRequestReview.id;
    await gql('mutation($rId:ID!){deletePullRequestReview(input:{pullRequestReviewId:$rId}){clientMutationId}}', {rId});
  },
  approve: async () => {
    const created = await gql(
      'mutation($prId:ID!,$sha:GitObjectID!){addPullRequestReview(input:{pullRequestId:$prId,commitOID:$sha}){pullRequestReview{id}}}',
      {prId: state.pull.node_id, sha: state.pull.head.sha}
    );
    const rId = created.addPullRequestReview.pullRequestReview.id;
    try {
      const s = await gql('mutation($rId:ID!){submitPullRequestReview(input:{pullRequestReviewId:$rId,event:APPROVE,body:"probe approve"}){pullRequestReview{state}}}', {rId});
      return s.submitPullRequestReview.pullRequestReview.state;
    } catch (err) {
      await gql('mutation($rId:ID!){deletePullRequestReview(input:{pullRequestReviewId:$rId}){clientMutationId}}', {rId}).catch(() => {});
      throw err;
    }
  },
  'approve-rest': async () => {
    const r = await call('POST', `repos/${repo}/pulls/${pr}/reviews`, {event: 'APPROVE', commit_id: state.pull.head.sha, body: 'probe approve (REST)'});
    return r.state;
  },
  decision: async () => {
    const d = await gql(`query{repository(owner:"${owner}",name:"${name}"){pullRequest(number:${pr}){reviewDecision mergeStateStatus}}}`);
    return JSON.stringify(d.repository.pullRequest);
  },
  whoami: async () => {
    const d = await gql('query{viewer{login}}').catch((e) => ({viewer: {login: `? ${e.message}`}}));
    return d.viewer.login;
  },
};

(async () => {
  const wanted = stepsArg === 'all' ? Object.keys(STEPS) : stepsArg.split(',');
  if (!wanted.includes('read')) wanted.unshift('read');
  for (const s of wanted) await step(s, STEPS[s]);
  console.log(results.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) {
    require('node:fs').appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${process.env.PROBE_LABEL || 'probe'}\n\`\`\`\n${results.join('\n')}\n\`\`\`\n`);
  }
})();
