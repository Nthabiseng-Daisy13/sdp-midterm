/** API types mirroring the backend responses. */

export interface RepoSource {
  type: 'clone' | 'zip'
  detail: string
}

export interface RepoStats {
  commits: number
  files: number
  added: number
  removed: number
  churn: number
  first_ts: number | null
  last_ts: number | null
}

export interface RepoInfo {
  id: string
  name: string
  state: 'indexing' | 'ready' | 'error'
  error: string | null
  source: RepoSource
  ref: string
  head: string | null
  created: string
  stats: RepoStats | null
}

export interface Job {
  id: string
  kind: 'upload' | 'clone' | 'reindex'
  repo_id: string | null
  repo_name: string | null
  state: 'running' | 'done' | 'error'
  log: string[]
  error: string | null
}

export type ObjectType = 'root' | 'dir' | 'file'

export interface ObjectMetrics {
  name: string
  path: string
  type: ObjectType
  added: number
  removed: number
  growth: number
  churn: number
  mods: number
  mod_freq: number
  churn_rate: number
  touched?: boolean
}

export interface AuthorRow {
  key: string
  name: string
  email: string
  commits: number
  added: number
  removed: number
  churn: number
  mods: number
  ownership: number
}

export interface TimelineBucket {
  t: number
  added: number
  removed: number
  growth: number
  churn: number
  commits: number
}

export interface MetricsResponse {
  repo: { id: string; name: string; ref: string; head: string | null }
  path: string
  object: ObjectMetrics
  commit_count: number
  base_commit_count: number
  total_commits: number
  children: ObjectMetrics[]
  top_files: ObjectMetrics[]
  authors: AuthorRow[]
  timeline: { granularity: string; buckets: TimelineBucket[] }
}

export interface CommitRow {
  hash: string
  short: string
  ts: number
  date: string
  author_key: string
  author_name: string
  author_email: string
  subject: string
  files: number
  added: number
  removed: number
  churn: number
}

export interface CommitsResponse {
  total: number
  commits: CommitRow[]
  limit: number
  offset: number
}

export interface AuthorAlias {
  name: string
  email: string
  commits: number
}

export interface AuthorGroup {
  key: string
  name: string
  email: string
  merged_manually: boolean
  aliases: AuthorAlias[]
  commits: number
  added: number
  removed: number
  churn: number
  first_ts: number | null
  last_ts: number | null
}

export interface AuthorsResponse {
  groups: AuthorGroup[]
  merge_ops: { keys: [string, string][]; target: [string, string] }[]
}

/** UI-side filter state. */
export interface Filters {
  authors: string[]
  from: string | null // ISO datetime (local input, treated as UTC)
  to: string | null
  commits: string[] | null
}

export const emptyFilters: Filters = { authors: [], from: null, to: null, commits: null }

export function filtersActive(f: Filters): boolean {
  return f.authors.length > 0 || f.from !== null || f.to !== null || (f.commits?.length ?? 0) > 0
}

/** Convert a datetime-local input value to a unix timestamp (UTC). */
export function dtToTs(v: string | null): number | null {
  if (!v) return null
  const ms = Date.parse(v + ':00Z') // treat as UTC
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000)
}
