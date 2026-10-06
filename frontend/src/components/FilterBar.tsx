import { useMemo, useState } from 'react'
import { Check, ChevronDown, Search, Users, X } from 'lucide-react'
import { useApp, useFetch } from '../store'
import { AuthorsResponse, dtToTs } from '../types'
import { fmtDate, fmtInt } from '../format'
import { useClickOutside } from './ui'

export function FilterBar({ totalCommits }: { totalCommits: number | null }) {
  const { repoId, filters, setFilters, path } = useApp()
  const [authorsOpen, setAuthorsOpen] = useState(false)
  const [authorSearch, setAuthorSearch] = useState('')
  const [presetsOpen, setPresetsOpen] = useState(false)

  const { data: authorsData } = useFetch<AuthorsResponse>(
    repoId ? `/api/repos/${repoId}/authors` : null,
  )
  const groups = useMemo(
    () =>
      (authorsData?.groups ?? []).filter((g) => {
        const needle = authorSearch.trim().toLowerCase()
        if (!needle) return true
        return (
          g.name.toLowerCase().includes(needle) ||
          g.email.toLowerCase().includes(needle)
        )
      }),
    [authorsData, authorSearch],
  )
  const authorByKey = useMemo(() => {
    const m = new Map<string, { name: string; email: string; commits: number }>()
    for (const g of authorsData?.groups ?? []) m.set(g.key, g)
    return m
  }, [authorsData])

  const dropdownRef = useClickOutside<HTMLDivElement>(() => setAuthorsOpen(false))
  const presetsRef = useClickOutside<HTMLDivElement>(() => setPresetsOpen(false))

  const selectedAuthors = filters.authors
  const activeCount =
    selectedAuthors.length +
    (filters.from ? 1 : 0) +
    (filters.to ? 1 : 0) +
    (filters.commits?.length ? 1 : 0)

  const setFromTo = (from: string | null, to: string | null) =>
    setFilters({ ...filters, from, to })

  const applyPreset = (days: number | null) => {
    if (days === null) {
      setFromTo(null, null)
    } else {
      const to = new Date()
      const from = new Date(to.getTime() - days * 86400000)
      setFromTo(isoLocal(from), isoLocal(to))
    }
    setPresetsOpen(false)
  }

  return (
    <div className="sticky top-0 z-30 border-b border-base-600/50 bg-base-900/95 px-5 py-2.5 backdrop-blur">
      <div className="flex flex-wrap items-center gap-2">
        {/* Author multiselect */}
        <div className="relative" ref={dropdownRef}>
          <button
            className={`btn border ${selectedAuthors.length ? 'border-churn/50 bg-churn/10 text-churn' : 'border-base-600/70 bg-base-800 text-ink-muted hover:text-ink'}`}
            onClick={() => setAuthorsOpen((v) => !v)}
          >
            <Users className="h-3.5 w-3.5" />
            Authors
            {selectedAuthors.length > 0 && (
              <span className="rounded-full bg-churn/20 px-1.5 text-[11px] font-bold">
                {selectedAuthors.length}
              </span>
            )}
            <ChevronDown className="h-3.5 w-3.5 opacity-60" />
          </button>
          {authorsOpen && (
            <div className="absolute left-0 top-full z-40 mt-1.5 w-80 rounded-xl border border-base-500/70 bg-base-850 p-2 shadow-xl">
              <div className="relative mb-2">
                <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-ink-faint" />
                <input
                  className="input w-full pl-8"
                  placeholder="Search authors…"
                  value={authorSearch}
                  onChange={(e) => setAuthorSearch(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="max-h-64 overflow-y-auto">
                {groups.map((g) => {
                  const checked = selectedAuthors.includes(g.key)
                  return (
                    <button
                      key={g.key}
                      className="row-hover flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left"
                      onClick={() =>
                        setFilters({
                          ...filters,
                          authors: checked
                            ? selectedAuthors.filter((k) => k !== g.key)
                            : [...selectedAuthors, g.key],
                        })
                      }
                    >
                      <span
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                          checked ? 'border-churn bg-churn text-white' : 'border-base-500'
                        }`}
                      >
                        {checked && <Check className="h-3 w-3" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{g.name}</span>
                        <span className="block truncate text-[11px] text-ink-faint">
                          {g.email}
                          {g.aliases.length > 1 && ` · ${g.aliases.length} identities`}
                        </span>
                      </span>
                      <span className="shrink-0 text-[11px] text-ink-faint">
                        {fmtInt(g.commits)}
                      </span>
                    </button>
                  )
                })}
                {groups.length === 0 && (
                  <div className="px-2 py-4 text-center text-xs text-ink-faint">No matches</div>
                )}
              </div>
              {selectedAuthors.length > 0 && (
                <button
                  className="btn-ghost mt-1 w-full text-xs"
                  onClick={() => setFilters({ ...filters, authors: [] })}
                >
                  Clear author selection
                </button>
              )}
            </div>
          )}
        </div>

        {/* Time range */}
        <div className="flex items-center gap-1.5">
          <input
            type="datetime-local"
            className="input w-[13.5rem]"
            title="From (inclusive, UTC)"
            value={filters.from ?? ''}
            onChange={(e) => setFromTo(e.target.value || null, filters.to)}
          />
          <span className="text-xs text-ink-faint">→</span>
          <input
            type="datetime-local"
            className="input w-[13.5rem]"
            title="To (exclusive, UTC)"
            value={filters.to ?? ''}
            onChange={(e) => setFromTo(filters.from, e.target.value || null)}
          />
        </div>

        {/* Presets */}
        <div className="relative" ref={presetsRef}>
          <button
            className="btn border border-base-600/70 bg-base-800 text-ink-muted hover:text-ink"
            onClick={() => setPresetsOpen((v) => !v)}
          >
            Presets <ChevronDown className="h-3.5 w-3.5 opacity-60" />
          </button>
          {presetsOpen && (
            <div className="absolute left-0 top-full z-40 mt-1.5 w-40 rounded-xl border border-base-500/70 bg-base-850 p-1.5 shadow-xl">
              {[
                { label: 'All time', days: null },
                { label: 'Last 7 days', days: 7 },
                { label: 'Last 30 days', days: 30 },
                { label: 'Last 90 days', days: 90 },
                { label: 'Last year', days: 365 },
              ].map((p) => (
                <button
                  key={p.label}
                  className="row-hover block w-full rounded-lg px-2.5 py-1.5 text-left text-sm"
                  onClick={() => applyPreset(p.days)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2 text-xs text-ink-faint">
          {path && <span className="chip">path: {path}</span>}
          {activeCount > 0 && (
            <button
              className="btn-ghost text-xs"
              onClick={() => setFilters({ authors: [], from: null, to: null, commits: null })}
            >
              <X className="h-3 w-3" /> Clear filters
            </button>
          )}
        </div>
      </div>

      {/* Active filter chips */}
      {(activeCount > 0 || totalCommits !== null) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
          {selectedAuthors.slice(0, 6).map((k) => {
            const a = authorByKey.get(k)
            return (
              <span key={k} className="chip">
                <Users className="h-3 w-3 text-churn" />
                {a ? a.name : 'author'}
                <button
                  className="text-ink-faint hover:text-ink"
                  onClick={() =>
                    setFilters({ ...filters, authors: selectedAuthors.filter((x) => x !== k) })
                  }
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            )
          })}
          {selectedAuthors.length > 6 && (
            <span className="chip">+{selectedAuthors.length - 6} more</span>
          )}
          {filters.from && (
            <span className="chip">
              from {fmtDate(dtToTs(filters.from))}
              <button className="text-ink-faint hover:text-ink" onClick={() => setFromTo(null, filters.to)}>
                <X className="h-3 w-3" />
              </button>
            </span>
          )}
          {filters.to && (
            <span className="chip">
              until {fmtDate(dtToTs(filters.to))}
              <button className="text-ink-faint hover:text-ink" onClick={() => setFromTo(filters.from, null)}>
                <X className="h-3 w-3" />
              </button>
            </span>
          )}
          {filters.commits && filters.commits.length > 0 && (
            <span className="chip border-violet/40 bg-violet/10 text-violet">
              {filters.commits.length} commits selected
              <button
                className="text-ink-faint hover:text-ink"
                onClick={() => setFilters({ ...filters, commits: null })}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function isoLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  )
}
