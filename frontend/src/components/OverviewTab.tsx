/** Dashboard overview: object metric cards, timeline, children & top files, authors. */
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { ChevronRight, FileText, Folder, FolderOpen, History } from 'lucide-react'
import { useApp, useApiQuery } from '../store'
import { MetricsResponse, ObjectMetrics, dtToTs } from '../types'
import { authorColor, extColor, fmtDate, fmtDateTime, fmtInt, fmtMonth, fmtNum, fmtPct, fmtSigned } from '../format'
import { Avatar, EmptyState, ErrorBox, MiniBar, Skeleton } from './ui'

export function OverviewTab() {
  const { repoId, path, setPath, filters, setFilters, dataVersion, repos } = useApp()
  const repo = repos.find((r) => r.id === repoId)

  const params = useMemo(
    () => ({
      path,
      author: filters.authors,
      commit: filters.commits ?? [],
      from_ts: dtToTs(filters.from),
      to_ts: dtToTs(filters.to),
    }),
    [path, filters],
  )
  const { data, error, loading } = useApiQuery<MetricsResponse>(
    repoId,
    'metrics',
    params,
    [dataVersion],
  )

  if (error) {
    return (
      <div className="p-5">
        <ErrorBox message={error} />
      </div>
    )
  }
  if (loading && !data) {
    return (
      <div className="space-y-4 p-5">
        <Skeleton className="h-6 w-64" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-[74px]" />
          ))}
        </div>
        <Skeleton className="h-[300px]" />
        <Skeleton className="h-64" />
      </div>
    )
  }
  if (!data) return null

  if (data.base_commit_count === 0) {
    return (
      <EmptyState
        icon={<History className="h-8 w-8" />}
        title="No commits match the current filters"
        hint="The time window or manual commit selection excludes every commit. Widen the range or clear the filters."
        action={
          <button
            className="btn-ghost mt-1 text-xs"
            onClick={() => setFilters({ authors: [], from: null, to: null, commits: null })}
          >
            Clear filters
          </button>
        }
      />
    )
  }

  const obj = data.object
  const isFile = obj.type === 'file'
  const maxChildChurn = Math.max(...data.children.map((c) => c.churn), 1)
  const maxFileChurn = Math.max(...data.top_files.map((c) => c.churn), 1)
  const maxAuthorChurn = Math.max(...data.authors.map((a) => a.churn), 1)

  return (
    <div className="space-y-4 p-5">
      <Breadcrumb path={data.path} repoName={repo?.name ?? data.repo.name} onNavigate={setPath} />

      {/* Metric cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Commits (|H|)"
          value={fmtInt(data.commit_count)}
          sub={
            data.commit_count !== data.base_commit_count
              ? `of ${fmtInt(data.base_commit_count)} in window`
              : `of ${fmtInt(data.total_commits)} in repository`
          }
        />
        <StatCard label="Added lines (l⁺)" value={fmtInt(obj.added)} valueClass="text-added" />
        <StatCard label="Removed lines (l⁻)" value={fmtInt(obj.removed)} valueClass="text-removed" />
        <StatCard
          label="Growth (δ)"
          value={fmtSigned(obj.growth)}
          valueClass={obj.growth > 0 ? 'text-added' : obj.growth < 0 ? 'text-removed' : undefined}
        />
        <StatCard label="Churn (λ)" value={fmtInt(obj.churn)} valueClass="text-churn" />
        <StatCard label="Modifications (n)" value={fmtInt(obj.mods)} sub="commits touching this object" />
        <StatCard label="Mod frequency (η)" value={fmtPct(obj.mod_freq)} sub="n / |H|" />
        <StatCard label="Churn rate (ρ)" value={fmtNum(obj.churn_rate)} sub="λ / |H| lines per commit" />
      </div>

      {/* Timeline */}
      <TimelinePanel data={data} />

      <div className={`grid gap-4 ${isFile ? '' : 'xl:grid-cols-5'}`}>
        {!isFile && (
          <section className="panel overflow-hidden xl:col-span-3">
            <PanelHeader
              title={path ? `Contents of ${path}` : 'Repository contents'}
              right={<span className="text-xs text-ink-faint">{data.children.length} entries</span>}
            />
            <ChildrenTable
              children={data.children}
              path={path}
              maxChurn={maxChildChurn}
              onNavigate={setPath}
            />
          </section>
        )}

        <section className={`panel overflow-hidden ${isFile ? '' : 'xl:col-span-2'}`}>
          <PanelHeader title="Authors" right={<span className="text-xs text-ink-faint">click to filter</span>} />
          <AuthorTable
            authors={data.authors}
            maxChurn={maxAuthorChurn}
            selected={filters.authors}
            onToggle={(key) => {
              const has = filters.authors.includes(key)
              setFilters({
                ...filters,
                authors: has ? filters.authors.filter((k) => k !== key) : [...filters.authors, key],
              })
            }}
          />
        </section>
      </div>

      {!isFile && data.top_files.length > 0 && (
        <section className="panel overflow-hidden">
          <PanelHeader
            title="Top churned files"
            right={<span className="text-xs text-ink-faint">across all directories · top 50</span>}
          />
          <TopFilesTable files={data.top_files} maxChurn={maxFileChurn} onNavigate={setPath} />
        </section>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

function Breadcrumb({
  path,
  repoName,
  onNavigate,
}: {
  path: string
  repoName: string
  onNavigate: (p: string) => void
}) {
  const segments = path ? path.split('/') : []
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
      <button
        className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-semibold text-ink transition-colors hover:bg-base-700/60"
        onClick={() => onNavigate('')}
      >
        <FolderOpen className="h-4 w-4 text-churn" />
        {repoName}
      </button>
      {segments.map((seg, i) => {
        const prefix = segments.slice(0, i + 1).join('/')
        const last = i === segments.length - 1
        return (
          <span key={prefix} className="flex min-w-0 items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
            {last ? (
              <span className="truncate font-mono text-sm font-medium text-ink">{seg}</span>
            ) : (
              <button
                className="truncate rounded-md px-1.5 py-0.5 font-mono text-ink-muted transition-colors hover:bg-base-700/60 hover:text-ink"
                onClick={() => onNavigate(prefix)}
              >
                {seg}
              </button>
            )}
          </span>
        )
      })}
    </div>
  )
}

function StatCard({
  label,
  value,
  sub,
  valueClass,
}: {
  label: string
  value: string
  sub?: string
  valueClass?: string
}) {
  return (
    <div className="panel px-3.5 py-3">
      <div className="text-xs font-semibold uppercase tracking-wider text-ink-faint">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tracking-tight tabular-nums ${valueClass ?? 'text-ink'}`}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-xs text-ink-faint" title={sub}>{sub}</div>}
    </div>
  )
}

function PanelHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-base-600/50 px-4 py-2.5">
      <h3 className="text-sm font-semibold">{title}</h3>
      {right}
    </div>
  )
}

// -- timeline ----------------------------------------------------------------

function TimelinePanel({ data }: { data: MetricsResponse }) {
  const { setTab } = useApp()
  const [showAdded, setShowAdded] = useState(true)
  const [showRemoved, setShowRemoved] = useState(true)
  const [showCommits, setShowCommits] = useState(true)

  const gran = data.timeline.granularity
  const xFmt =
    gran.includes('hour') ? fmtDateTime
      : gran === 'month' || gran.includes('quarter') || gran.includes('year') ? fmtMonth
        : fmtDate
  const buckets = data.timeline.buckets
  const maxLines = Math.max(...buckets.map((b) => Math.max(b.added, b.removed)), 1)

  const toggles: { label: string; color: string; on: boolean; set: (v: boolean) => void }[] = [
    { label: 'Added', color: '#047857', on: showAdded, set: setShowAdded },
    { label: 'Removed', color: '#BE123C', on: showRemoved, set: setShowRemoved },
    { label: 'Commits', color: '#C2255C', on: showCommits, set: setShowCommits },
  ]

  return (
    <section className="panel">
      <PanelHeader
        title="Activity over time"
        right={
          <div className="flex items-center gap-3">
            <span className="text-xs text-ink-faint">bucket: {gran}</span>
            <div className="flex items-center gap-1">
              {toggles.map((t) => (
                <button
                  key={t.label}
                  className={`chip transition-opacity ${t.on ? '' : 'opacity-40'}`}
                  onClick={() => t.set(!t.on)}
                >
                  <span className="h-2 w-2 rounded-full" style={{ background: t.color }} />
                  {t.label}
                </button>
              ))}
            </div>
            <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setTab('commits')}>
              Commit list →
            </button>
          </div>
        }
      />
      <div className="p-3 pr-4">
        {buckets.length === 0 ? (
          <div className="flex h-[220px] items-center justify-center text-sm text-ink-faint">
            No activity in this view (all metrics are zero).
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={230}>
            <ComposedChart data={buckets} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="tlAdded" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#047857" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#047857" stopOpacity={0.03} />
                </linearGradient>
                <linearGradient id="tlRemoved" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#BE123C" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#BE123C" stopOpacity={0.03} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#efdfc0" vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                domain={['dataMin', 'dataMax']}
                tickFormatter={xFmt}
                tickLine={false}
                axisLine={{ stroke: '#e8d3af' }}
                minTickGap={56}
              />
              <YAxis
                yAxisId="lines"
                width={46}
                domain={[0, maxLines * 1.1]}
                tickFormatter={fmtNum}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                yAxisId="commits"
                orientation="right"
                width={38}
                tickFormatter={fmtNum}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip content={<TimelineTooltip />} />
              {showCommits && (
                <Bar
                  yAxisId="commits"
                  dataKey="commits"
                  name="commits"
                  fill="#C2255C"
                  fillOpacity={0.25}
                  radius={[2, 2, 0, 0]}
                />
              )}
              {showAdded && (
                <Area
                  yAxisId="lines"
                  dataKey="added"
                  name="added"
                  stroke="#047857"
                  strokeWidth={2}
                  fill="url(#tlAdded)"
                />
              )}
              {showRemoved && (
                <Area
                  yAxisId="lines"
                  dataKey="removed"
                  name="removed"
                  stroke="#BE123C"
                  strokeWidth={2}
                  fill="url(#tlRemoved)"
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  )
}

interface TooltipItem {
  name?: string | number
  value?: number | string
  color?: string
}

function TimelineTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: TooltipItem[]
  label?: number | string
}) {
  if (!active || !payload || payload.length === 0) return null
  const t = typeof label === 'number' ? label : Number(label)
  const byName = new Map(payload.map((p) => [String(p.name), p.value ?? 0]))
  const added = Number(byName.get('added') ?? 0)
  const removed = Number(byName.get('removed') ?? 0)
  const commits = Number(byName.get('commits') ?? 0)
  return (
    <div className="rounded-lg border border-base-500/80 bg-base-850/95 px-3 py-2 text-xs shadow-xl backdrop-blur">
      <div className="mb-1 font-semibold">{fmtDateTime(t)} UTC</div>
      <Row label="Added" value={fmtInt(added)} color="#047857" />
      <Row label="Removed" value={fmtInt(removed)} color="#BE123C" />
      <Row label="Growth" value={fmtSigned(added - removed)} color="#B45309" />
      <Row label="Churn" value={fmtInt(added + removed)} color="#C2255C" />
      <Row label="Commits" value={fmtInt(commits)} color="#7C5568" />
    </div>
  )
}

function Row({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex items-center justify-between gap-6">
      <span className="flex items-center gap-1.5 text-ink-muted">
        <span className="h-2 w-2 rounded-full" style={{ background: color }} />
        {label}
      </span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  )
}

// -- tables ------------------------------------------------------------------

function parentPath(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? '' : p.slice(0, i)
}

function ChildrenTable({
  children,
  path,
  maxChurn,
  onNavigate,
}: {
  children: ObjectMetrics[]
  path: string
  maxChurn: number
  onNavigate: (p: string) => void
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-base-600/50">
            <th className="th">Name</th>
            <th className="th w-48">Churn</th>
            <th className="th text-right">Added</th>
            <th className="th text-right">Removed</th>
            <th className="th text-right">Growth</th>
            <th className="th text-right">Mods</th>
            <th className="th text-right">Mod freq</th>
          </tr>
        </thead>
        <tbody>
          {path && (
            <tr
              className="row-hover cursor-pointer text-ink-muted"
              onClick={() => onNavigate(parentPath(path))}
            >
              <td className="td" colSpan={7}>
                <span className="flex items-center gap-2">
                  <FolderOpen className="h-4 w-4" /> ..
                </span>
              </td>
            </tr>
          )}
          {children.map((c) => (
            <tr
              key={c.path}
              className={`row-hover cursor-pointer ${c.touched ? '' : 'opacity-50'}`}
              title={c.touched ? c.path : `${c.path} — no changes in this view`}
              onClick={() => onNavigate(c.path)}
            >
              <td className="td max-w-[22rem]">
                <span className="flex items-center gap-2">
                  {c.type === 'dir' ? (
                    <Folder className="h-4 w-4 shrink-0 text-churn" />
                  ) : (
                    <FileText className="h-4 w-4 shrink-0" style={{ color: extColor(c.name) }} />
                  )}
                  <span className="truncate font-medium">{c.name}</span>
                </span>
              </td>
              <td className="td">
                <span className="flex items-center gap-2">
                  <span className="w-14 text-right tabular-nums">{fmtInt(c.churn)}</span>
                  <MiniBar value={c.churn} max={maxChurn} color="#C2255C" className="flex-1" />
                </span>
              </td>
              <td className="td text-right tabular-nums text-added">{c.touched ? fmtInt(c.added) : '—'}</td>
              <td className="td text-right tabular-nums text-removed">{c.touched ? fmtInt(c.removed) : '—'}</td>
              <td
                className={`td text-right tabular-nums ${
                  c.growth > 0 ? 'text-added' : c.growth < 0 ? 'text-removed' : 'text-ink-faint'
                }`}
              >
                {c.touched ? fmtSigned(c.growth) : '—'}
              </td>
              <td className="td text-right tabular-nums">{c.touched ? fmtInt(c.mods) : '—'}</td>
              <td className="td text-right tabular-nums text-ink-muted">
                {c.touched ? fmtPct(c.mod_freq) : '—'}
              </td>
            </tr>
          ))}
          {children.length === 0 && (
            <tr>
              <td className="td py-8 text-center text-ink-faint" colSpan={7}>
                No entries — nothing under this path changed in the selected commit set.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function TopFilesTable({
  files,
  maxChurn,
  onNavigate,
}: {
  files: ObjectMetrics[]
  maxChurn: number
  onNavigate: (p: string) => void
}) {
  return (
    <div className="max-h-[26rem] overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-base-800/95 backdrop-blur">
          <tr className="border-b border-base-600/50">
            <th className="th">File</th>
            <th className="th w-48">Churn</th>
            <th className="th text-right">Added</th>
            <th className="th text-right">Removed</th>
            <th className="th text-right">Mods</th>
            <th className="th text-right">Mod freq</th>
          </tr>
        </thead>
        <tbody>
          {files.map((f) => (
            <tr
              key={f.path}
              className="row-hover cursor-pointer"
              title={f.path}
              onClick={() => onNavigate(f.path)}
            >
              <td className="td max-w-[30rem]">
                <span className="flex items-center gap-2">
                  <FileText className="h-4 w-4 shrink-0" style={{ color: extColor(f.name) }} />
                  <span className="truncate font-mono text-[13px] text-ink-muted">{f.path}</span>
                </span>
              </td>
              <td className="td">
                <span className="flex items-center gap-2">
                  <span className="w-14 text-right tabular-nums">{fmtInt(f.churn)}</span>
                  <MiniBar value={f.churn} max={maxChurn} color="#C2255C" className="flex-1" />
                </span>
              </td>
              <td className="td text-right tabular-nums text-added">{fmtInt(f.added)}</td>
              <td className="td text-right tabular-nums text-removed">{fmtInt(f.removed)}</td>
              <td className="td text-right tabular-nums">{fmtInt(f.mods)}</td>
              <td className="td text-right tabular-nums text-ink-muted">{fmtPct(f.mod_freq)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function AuthorTable({
  authors,
  maxChurn,
  selected,
  onToggle,
}: {
  authors: MetricsResponse['authors']
  maxChurn: number
  selected: string[]
  onToggle: (key: string) => void
}) {
  if (authors.length === 0) {
    return <div className="px-4 py-8 text-center text-sm text-ink-faint">No authors in this commit set.</div>
  }
  return (
    <div className="max-h-[34rem] overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-base-800/95 backdrop-blur">
          <tr className="border-b border-base-600/50">
            <th className="th">Author</th>
            <th className="th text-right">Commits</th>
            <th className="th w-36">Churn</th>
            <th className="th w-28">Own</th>
          </tr>
        </thead>
        <tbody>
          {authors.map((a) => {
            const active = selected.includes(a.key)
            return (
              <tr
                key={a.key}
                className={`row-hover cursor-pointer ${active ? 'bg-churn/10' : ''}`}
                title={`${a.name} <${a.email}> — click to ${active ? 'remove from' : 'add to'} the author filter`}
                onClick={() => onToggle(a.key)}
              >
                <td className="td max-w-[16rem]">
                  <span className="flex items-center gap-2">
                    <Avatar name={a.name} color={authorColor(a.key)} />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{a.name}</span>
                      <span className="block truncate text-[11px] text-ink-faint">{a.email}</span>
                    </span>
                  </span>
                </td>
                <td className="td text-right tabular-nums">{fmtInt(a.commits)}</td>
                <td className="td">
                  <span className="flex items-center gap-2">
                    <span className="w-12 text-right tabular-nums">{fmtInt(a.churn)}</span>
                    <MiniBar value={a.churn} max={maxChurn} color={authorColor(a.key)} className="flex-1" />
                  </span>
                </td>
                <td className="td tabular-nums text-ink-muted">{fmtPct(a.ownership)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
