/** Commit list: search, paginate, and manually select commits as a filter. */
import { useEffect, useMemo, useState } from 'react'
import { Check, Filter, Search, X } from 'lucide-react'
import { useApp, useApiQuery } from '../store'
import { CommitsResponse, dtToTs } from '../types'
import { authorColor, fmtDateTime, fmtInt } from '../format'
import { Avatar, EmptyState, ErrorBox, Skeleton, useDebounced } from './ui'

export function CommitsTab() {
  const { repoId, filters, setFilters, dataVersion } = useApp()
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebounced(search, 350)
  const [limit, setLimit] = useState(50)
  const [offset, setOffset] = useState(0)
  const [selection, setSelection] = useState<Set<string>>(new Set())

  // Reset local state when switching repositories.
  useEffect(() => {
    setSelection(new Set())
    setSearch('')
    setOffset(0)
  }, [repoId])

  // Track externally-applied commit filters (e.g. loaded from a shared URL).
  useEffect(() => {
    setSelection(new Set(filters.commits ?? []))
  }, [filters.commits])

  // Jump back to the first page whenever the search box or filters change.
  useEffect(() => {
    setOffset(0)
  }, [debouncedSearch, filters])

  const params = useMemo(
    () => ({
      author: filters.authors,
      from_ts: dtToTs(filters.from),
      to_ts: dtToTs(filters.to),
      q: debouncedSearch,
      limit,
      offset,
    }),
    // The commit selection is intentionally NOT sent: the list is used to
    // edit the selection, so it must keep showing unselected commits.
    [filters, debouncedSearch, limit, offset],
  )
  const { data, error, loading } = useApiQuery<CommitsResponse>(
    repoId,
    'commits',
    params,
    [dataVersion],
  )

  const commits = data?.commits ?? []
  const total = data?.total ?? 0
  const pageAllChecked = commits.length > 0 && commits.every((c) => selection.has(c.hash))
  const commitFilterActive = (filters.commits?.length ?? 0) > 0

  const toggleHash = (hash: string) => {
    setSelection((s) => {
      const next = new Set(s)
      if (next.has(hash)) next.delete(hash)
      else next.add(hash)
      return next
    })
  }

  const togglePage = () => {
    setSelection((s) => {
      const next = new Set(s)
      if (pageAllChecked) {
        for (const c of commits) next.delete(c.hash)
      } else {
        for (const c of commits) next.add(c.hash)
      }
      return next
    })
  }

  const applySelection = () => {
    setFilters({ ...filters, commits: selection.size > 0 ? [...selection] : null })
  }

  const clearSelection = () => {
    setSelection(new Set())
    if (commitFilterActive) setFilters({ ...filters, commits: null })
  }

  if (error) {
    return (
      <div className="p-5">
        <ErrorBox message={error} />
      </div>
    )
  }

  return (
    <div className="space-y-3 p-5">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[16rem] flex-1 sm:max-w-md">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-ink-faint" />
          <input
            className="input w-full pl-8"
            placeholder="Search hash, subject or author…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select
          className="input"
          value={limit}
          onChange={(e) => {
            setLimit(Number(e.target.value))
            setOffset(0)
          }}
          title="Rows per page"
        >
          {[50, 100, 200].map((n) => (
            <option key={n} value={n}>
              {n} / page
            </option>
          ))}
        </select>
        <span className="ml-auto text-xs text-ink-faint">
          {loading && !data ? 'Loading…' : `${fmtInt(total)} commits in view`}
        </span>
      </div>

      {/* Commit-filter status */}
      {commitFilterActive && (
        <div className="flex items-center gap-2 rounded-lg border border-violet/40 bg-violet/10 px-3 py-2 text-xs text-violet">
          <Filter className="h-3.5 w-3.5" />
          Metrics are currently restricted to {fmtInt(filters.commits!.length)} manually selected
          commits. Select or deselect below, then re-apply.
          <button
            className="ml-auto text-ink-muted underline-offset-2 hover:text-ink hover:underline"
            onClick={() => setFilters({ ...filters, commits: null })}
          >
            Remove filter
          </button>
        </div>
      )}

      {/* Selection action bar */}
      {selection.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-churn/40 bg-churn/10 px-3 py-2 text-xs">
          <span className="font-semibold text-churn">{fmtInt(selection.size)} selected</span>
          <span className="text-ink-muted">
            Use the checkboxes to build a manual commit set, then apply it as a filter.
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button className="btn-primary px-2.5 py-1 text-xs" onClick={applySelection}>
              <Filter className="h-3.5 w-3.5" />
              {commitFilterActive ? 'Update commit filter' : 'Filter metrics by selection'}
            </button>
            <button className="btn-ghost px-2.5 py-1 text-xs" onClick={clearSelection}>
              <X className="h-3.5 w-3.5" /> Clear
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="panel overflow-hidden">
        {loading && !data ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 10 }, (_, i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </div>
        ) : commits.length === 0 ? (
          <EmptyState
            title="No commits found"
            hint={
              debouncedSearch
                ? 'Nothing matches the search text within the current filters.'
                : 'The current time/author filters exclude every commit.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-base-600/50">
                  <th className="th w-10">
                    <button
                      className="flex h-4 w-4 items-center justify-center rounded border transition-colors"
                      style={{
                        borderColor: pageAllChecked ? '#C2255C' : '#D9BE94',
                        background: pageAllChecked ? '#C2255C' : 'transparent',
                      }}
                      title="Select all commits on this page"
                      onClick={togglePage}
                    >
                      {pageAllChecked && <Check className="h-3 w-3 text-white" />}
                    </button>
                  </th>
                  <th className="th">Hash</th>
                  <th className="th">Date</th>
                  <th className="th">Author</th>
                  <th className="th">Subject</th>
                  <th className="th text-right">Files</th>
                  <th className="th text-right">Lines</th>
                  <th className="th text-right">Churn</th>
                </tr>
              </thead>
              <tbody>
                {commits.map((c) => {
                  const checked = selection.has(c.hash)
                  return (
                    <tr
                      key={c.hash}
                      className={`row-hover ${checked ? 'bg-churn/10' : ''}`}
                      title={c.hash}
                    >
                      <td className="td">
                        <button
                          className="flex h-4 w-4 items-center justify-center rounded border transition-colors"
                          style={{
                            borderColor: checked ? '#C2255C' : '#D9BE94',
                            background: checked ? '#C2255C' : 'transparent',
                          }}
                          onClick={() => toggleHash(c.hash)}
                          aria-label={checked ? 'Deselect commit' : 'Select commit'}
                        >
                          {checked && <Check className="h-3 w-3 text-white" />}
                        </button>
                      </td>
                      <td className="td font-mono text-[13px] text-churn">{c.short}</td>
                      <td className="td text-ink-muted">{fmtDateTime(c.ts)}</td>
                      <td className="td">
                        <span className="flex items-center gap-2">
                          <Avatar name={c.author_name} color={authorColor(c.author_key)} size="h-5 w-5" />
                          <span className="max-w-[10rem] truncate">{c.author_name}</span>
                        </span>
                      </td>
                      <td className="td max-w-[28rem]">
                        <span className="block truncate" title={c.subject}>
                          {c.subject}
                        </span>
                      </td>
                      <td className="td text-right tabular-nums text-ink-muted">{fmtInt(c.files)}</td>
                      <td className="td text-right tabular-nums">
                        <span className="text-added">+{fmtInt(c.added)}</span>{' '}
                        <span className="text-removed">−{fmtInt(c.removed)}</span>
                      </td>
                      <td className="td text-right tabular-nums">{fmtInt(c.churn)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {data && total > 0 && (
          <div className="flex items-center justify-between border-t border-base-600/50 px-4 py-2 text-xs text-ink-muted">
            <span>
              Showing {fmtInt(offset + 1)}–{fmtInt(Math.min(offset + limit, total))} of {fmtInt(total)}
            </span>
            <span className="flex items-center gap-1.5">
              <button
                className="btn-ghost px-2 py-1 text-xs"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - limit))}
              >
                ← Prev
              </button>
              <button
                className="btn-ghost px-2 py-1 text-xs"
                disabled={offset + limit >= total}
                onClick={() => setOffset(offset + limit)}
              >
                Next →
              </button>
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
