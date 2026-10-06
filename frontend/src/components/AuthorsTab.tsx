/** Author management: browse identity groups, merge (manually or via mailmap), undo merges. */
import { useEffect, useState } from 'react'
import { Check, ChevronDown, ChevronRight, GitMerge, Info, Undo2 } from 'lucide-react'
import { api } from '../api'
import { useApp, useFetch } from '../store'
import { AuthorGroup, AuthorsResponse } from '../types'
import { authorColor, fmtDate, fmtInt } from '../format'
import { Avatar, ErrorBox, MiniBar, Modal, Skeleton } from './ui'

export function AuthorsTab() {
  const { repoId, toast, bumpData, dataVersion } = useApp()
  const { data, error, loading, reload } = useFetch<AuthorsResponse>(
    repoId ? `/api/repos/${repoId}/authors` : null,
    [dataVersion],
  )

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [mergeOpen, setMergeOpen] = useState(false)
  const [mergeTarget, setMergeTarget] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setSelected(new Set())
    setExpanded(new Set())
  }, [repoId])

  const groups = data?.groups ?? []
  const maxChurn = Math.max(...groups.map((g) => g.churn), 1)

  const toggleSelected = (key: string) => {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleExpanded = (key: string) => {
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const openMerge = () => {
    setMergeTarget(selected.values().next().value ?? null)
    setMergeOpen(true)
  }

  const doMerge = async () => {
    if (!repoId || !mergeTarget) return
    setBusy(true)
    try {
      await api.post(`/api/repos/${repoId}/authors/merge`, {
        keys: [...selected],
        target: mergeTarget,
      })
      toast('success', `Merged ${selected.size} authors into one identity`)
      setSelected(new Set())
      setMergeOpen(false)
      reload()
      bumpData()
    } catch (e) {
      toast('error', `Merge failed: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const undoMerge = async (index: number) => {
    if (!repoId) return
    setBusy(true)
    try {
      await api.post(`/api/repos/${repoId}/authors/unmerge`, { index })
      toast('info', 'Merge undone')
      reload()
      bumpData()
    } catch (e) {
      toast('error', `Undo failed: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  if (error) {
    return (
      <div className="p-5">
        <ErrorBox message={error} />
      </div>
    )
  }

  return (
    <div className="space-y-4 p-5">
      {/* Explainer */}
      <div className="flex items-start gap-3 rounded-lg border border-base-600/60 bg-base-850/60 px-4 py-3 text-xs leading-relaxed text-ink-muted">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-churn" />
        <div>
          Identities are merged automatically when the repository ships a{' '}
          <span className="font-mono text-ink">.mailmap</span> (git resolves it during indexing).
          Authors without a mailmap can be merged manually below — select two or more rows, choose
          the surviving identity, and merge. Manual merges are stored per repository and can be
          undone at any time.
        </div>
      </div>

      {/* Manual merge ops */}
      {data && data.merge_ops.length > 0 && (
        <section className="panel">
          <div className="border-b border-base-600/50 px-4 py-2.5">
            <h3 className="text-sm font-semibold">Manual merges</h3>
          </div>
          <div className="divide-y divide-base-600/40">
            {data.merge_ops.map((op, i) => (
              <div key={i} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2.5 text-sm">
                <span className="chip border-violet/40 bg-violet/10 text-violet">
                  <GitMerge className="h-3 w-3" /> #{i + 1}
                </span>
                {op.keys.map(([name, email], j) => (
                  <span key={email + name} className="flex items-center gap-2">
                    {j > 0 && <span className="text-ink-faint">+</span>}
                    <span title={email}>{name}</span>
                  </span>
                ))}
                <span className="text-ink-faint">→</span>
                <span className="font-medium" title={op.target[1]}>
                  {op.target[0]}
                </span>
                <button
                  className="btn-ghost ml-auto px-2 py-1 text-xs"
                  disabled={busy}
                  onClick={() => undoMerge(i)}
                >
                  <Undo2 className="h-3.5 w-3.5" /> Undo
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Selection bar */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-violet/40 bg-violet/10 px-3 py-2 text-xs">
          <span className="font-semibold text-violet">{selected.size} authors selected</span>
          <span className="text-ink-muted">
            Merging combines their commits, churn and ownership into a single identity.
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button className="btn-primary px-2.5 py-1 text-xs" onClick={openMerge}>
              <GitMerge className="h-3.5 w-3.5" /> Merge…
            </button>
            <button
              className="btn-ghost px-2.5 py-1 text-xs"
              onClick={() => setSelected(new Set())}
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Groups table */}
      <section className="panel overflow-hidden">
        <div className="flex items-center justify-between border-b border-base-600/50 px-4 py-2.5">
          <h3 className="text-sm font-semibold">Authors ({groups.length})</h3>
          <span className="text-xs text-ink-faint">
            {groups.filter((g) => g.aliases.length > 1).length} with multiple identities
          </span>
        </div>
        {loading && !data ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-base-600/50">
                  <th className="th w-10"></th>
                  <th className="th">Author</th>
                  <th className="th text-right">Identities</th>
                  <th className="th text-right">Commits</th>
                  <th className="th text-right">Added</th>
                  <th className="th text-right">Removed</th>
                  <th className="th w-44">Churn</th>
                  <th className="th text-right">Active</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const checked = selected.has(g.key)
                  const isOpen = expanded.has(g.key)
                  return (
                    <AuthorRows
                      key={g.key}
                      group={g}
                      checked={checked}
                      isOpen={isOpen}
                      maxChurn={maxChurn}
                      onToggleSelect={() => toggleSelected(g.key)}
                      onToggleExpand={() => toggleExpanded(g.key)}
                    />
                  )
                })}
                {groups.length === 0 && (
                  <tr>
                    <td className="td py-8 text-center text-ink-faint" colSpan={8}>
                      No authors found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Merge dialog */}
      {mergeOpen && (
        <Modal title={`Merge ${selected.size} authors`} onClose={() => setMergeOpen(false)} width="max-w-md">
          <div className="space-y-3">
            <p className="text-xs leading-relaxed text-ink-muted">
              Choose the identity that survives the merge — its name and email will represent the
              whole group everywhere (metrics, filters and author lists).
            </p>
            <div className="space-y-1.5">
              {[...selected].map((key) => {
                const g = groups.find((x) => x.key === key)
                if (!g) return null
                const active = mergeTarget === key
                return (
                  <button
                    key={key}
                    className={`row-hover flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left ${
                      active ? 'border-violet/50 bg-violet/10' : 'border-base-600/50'
                    }`}
                    onClick={() => setMergeTarget(key)}
                  >
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                        active ? 'border-violet' : 'border-base-500'
                      }`}
                    >
                      {active && <span className="h-2 w-2 rounded-full bg-violet" />}
                    </span>
                    <Avatar name={g.name} color={authorColor(g.key)} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{g.name}</span>
                      <span className="block truncate text-[11px] text-ink-faint">{g.email}</span>
                    </span>
                    <span className="shrink-0 text-[11px] text-ink-faint">
                      {fmtInt(g.commits)} commits
                    </span>
                  </button>
                )
              })}
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button className="btn-ghost" onClick={() => setMergeOpen(false)}>
                Cancel
              </button>
              <button
                className="btn-primary"
                disabled={busy || !mergeTarget}
                onClick={() => void doMerge()}
              >
                {busy ? 'Merging…' : 'Merge authors'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

function AuthorRows({
  group,
  checked,
  isOpen,
  maxChurn,
  onToggleSelect,
  onToggleExpand,
}: {
  group: AuthorGroup
  checked: boolean
  isOpen: boolean
  maxChurn: number
  onToggleSelect: () => void
  onToggleExpand: () => void
}) {
  return (
    <>
      <tr className={`row-hover ${checked ? 'bg-violet/10' : ''}`}>
        <td className="td">
          <button
            className="flex h-4 w-4 items-center justify-center rounded border transition-colors"
            style={{
              borderColor: checked ? '#a78bfa' : '#2b3a55',
              background: checked ? '#a78bfa' : 'transparent',
            }}
            onClick={onToggleSelect}
            aria-label={checked ? 'Deselect author' : 'Select author'}
          >
            {checked && <Check className="h-3 w-3 text-base-900" />}
          </button>
        </td>
        <td className="td">
          <span className="flex items-center gap-2.5">
            <Avatar name={group.name} color={authorColor(group.key)} />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5">
                <span className="truncate font-medium">{group.name}</span>
                {group.merged_manually && (
                  <span className="chip border-violet/40 bg-violet/10 px-1.5 py-0 text-[10px] text-violet">
                    merged
                  </span>
                )}
                {!group.merged_manually && group.aliases.length > 1 && (
                  <span className="chip border-churn/40 bg-churn/10 px-1.5 py-0 text-[10px] text-churn">
                    mailmap
                  </span>
                )}
              </span>
              <span className="block truncate text-[11px] text-ink-faint">{group.email}</span>
            </span>
          </span>
        </td>
        <td className="td text-right">
          {group.aliases.length > 1 ? (
            <button
              className="inline-flex items-center gap-0.5 text-churn hover:underline"
              onClick={onToggleExpand}
              title="Show all identities"
            >
              {group.aliases.length}
              {isOpen ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </button>
          ) : (
            <span className="text-ink-faint">1</span>
          )}
        </td>
        <td className="td text-right tabular-nums">{fmtInt(group.commits)}</td>
        <td className="td text-right tabular-nums text-added">{fmtInt(group.added)}</td>
        <td className="td text-right tabular-nums text-removed">{fmtInt(group.removed)}</td>
        <td className="td">
          <span className="flex items-center gap-2">
            <span className="w-14 text-right tabular-nums">{fmtInt(group.churn)}</span>
            <MiniBar value={group.churn} max={maxChurn} color={authorColor(group.key)} className="flex-1" />
          </span>
        </td>
        <td className="td text-right text-xs text-ink-muted">
          {fmtDate(group.first_ts)} → {fmtDate(group.last_ts)}
        </td>
      </tr>
      {isOpen && (
        <tr>
          <td colSpan={8} className="px-4 pb-3 pt-0">
            <div className="rounded-lg border border-base-600/50 bg-base-900/50 p-2.5">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                Identities in this group
              </div>
              <div className="space-y-1">
                {group.aliases.map((a) => (
                  <div key={a.email + a.name} className="flex items-center gap-2 text-xs">
                    <Avatar name={a.name} color={authorColor(group.key)} size="h-4 w-4" />
                    <span className="font-medium">{a.name}</span>
                    <span className="text-ink-faint">&lt;{a.email}&gt;</span>
                    <span className="ml-auto tabular-nums text-ink-faint">
                      {fmtInt(a.commits)} commits
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
