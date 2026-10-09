import type { Mergeable, OpenPullRequest } from './branch-update.js'
import process from 'node:process'
import { REVIEW_STATUS_CONTEXT } from '../ghosts/verdict.js'
import { nextToUpdate, TOKEN_SECRET } from './branch-update.js'

const BASE = 'main'
const API = 'https://api.github.com'

interface PullRequestNode {
  number: number
  createdAt: string
  isDraft: boolean
  isCrossRepository: boolean
  mergeable: Mergeable
  headRefOid: string
  autoMergeRequest: { enabledAt: string } | null
  commits: { nodes: { commit: { status: { contexts: { context: string }[] } | null } }[] }
}

const QUERY = `query($owner: String!, $name: String!, $base: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, baseRefName: $base, first: 100) {
      pageInfo { hasNextPage }
      nodes { number createdAt isDraft isCrossRepository mergeable headRefOid autoMergeRequest { enabledAt } commits(last: 1) { nodes { commit { status { contexts { context } } } } } }
    }
  }
}`

function fail(message: string): never {
  console.error(`::error::${message}`)
  process.exit(1)
}

const token = process.env.GH_TOKEN
const repository = process.env.GITHUB_REPOSITORY
if (!token)
  fail(`The repository secret ${TOKEN_SECRET} is not set. A push made with GITHUB_TOKEN starts no CI on the updated branch, so this workflow refuses to run without it.`)
if (!repository)
  fail('GITHUB_REPOSITORY is not set.')

const headers = { 'authorization': `Bearer ${token}`, 'accept': 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, { ...init, headers })
  if (!response.ok)
    fail(`${init.method ?? 'GET'} ${path} answered ${response.status}: ${await response.text()}`)
  return await response.json() as T
}

const [owner, name] = repository.split('/')
const { data } = await api<{ data: { repository: { pullRequests: { pageInfo: { hasNextPage: boolean }, nodes: PullRequestNode[] } } } }>('/graphql', {
  method: 'POST',
  body: JSON.stringify({ query: QUERY, variables: { owner, name, base: BASE } }),
})
const { pageInfo, nodes } = data.repository.pullRequests
if (pageInfo.hasNextPage)
  fail(`More than 100 pull requests are open against ${BASE}; this workflow reads one page and will not choose from part of the list.`)

const prs: OpenPullRequest[] = await Promise.all(nodes.map(async node => ({
  number: node.number,
  createdAt: node.createdAt,
  isDraft: node.isDraft,
  isCrossRepository: node.isCrossRepository,
  autoMerge: node.autoMergeRequest !== null,
  mergeable: node.mergeable,
  hasReviewStatus: node.commits.nodes.some(({ commit }) => commit.status?.contexts.some(({ context }) => context === REVIEW_STATUS_CONTEXT) ?? false),
  behindBy: (await api<{ behind_by: number }>(`/repos/${repository}/compare/${BASE}...${node.headRefOid}`)).behind_by,
})))

const next = nextToUpdate(prs)
if (!next) {
  console.log(`No open pull request against ${BASE} has auto-merge on, is behind ${BASE}, carries no ${REVIEW_STATUS_CONTEXT} status and can be updated; nothing to do.`)
  process.exit(0)
}

const head = nodes.find(node => node.number === next.number)!.headRefOid
await api(`/repos/${repository}/pulls/${next.number}/update-branch`, { method: 'PUT', body: JSON.stringify({ expected_head_sha: head }) })
console.log(`Updated PR #${next.number}, ${next.behindBy} commit(s) behind ${BASE}, from ${head}.`)
