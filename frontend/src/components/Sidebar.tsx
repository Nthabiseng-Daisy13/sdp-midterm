import { Boxes, GitBranch, Plus } from 'lucide-react'
import { useApp } from '../store'
import { Spinner } from './ui'

export function Sidebar({ onAdd }: { onAdd: () => void }) {
  const { repos, repoId, openRepo, reposLoading } = useApp()

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-base-600/50 bg-base-850/80">
      <div className="flex items-center gap-2.5 px-4 py-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-churn/15 ring-1 ring-churn/30">
          <GitBranch className="h-4 w-4 text-churn" />
        </div>
        <div>
          <div className="text-sm font-bold leading-tight tracking-tight">RAT</div>
          <div className="text-[10px] uppercase tracking-widest text-ink-faint">Repo Analysis Tool</div>
        </div>
      </div>

      <div className="px-3 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
        Repositories
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        {reposLoading && (
          <div className="flex items-center gap-2 px-2 py-2 text-sm text-ink-faint">
            <Spinner className="h-3.5 w-3.5" /> Loading…
          </div>
        )}
        {!reposLoading && repos.length === 0 && (
          <div className="px-3 py-4 text-xs leading-relaxed text-ink-faint">
            No repositories yet. Add one to start analysing commit history, churn and authorship.
          </div>
        )}
        {repos.map((r) => {
          const active = r.id === repoId
          return (
            <button
              key={r.id}
              onClick={() => openRepo(r.id)}
              className={`group flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
                active ? 'bg-churn/10 ring-1 ring-churn/30' : 'hover:bg-base-700/50'
              }`}
            >
              <Boxes
                className={`h-4 w-4 shrink-0 ${active ? 'text-churn' : 'text-ink-faint group-hover:text-ink-muted'}`}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{r.name}</span>
                <span className="block truncate text-[11px] text-ink-faint">
                  {r.state === 'indexing' && 'Indexing…'}
                  {r.state === 'error' && 'Failed'}
                  {r.state === 'ready' && r.stats && `${r.stats.commits.toLocaleString()} commits`}
                  {r.state === 'ready' && !r.stats && 'Ready'}
                </span>
              </span>
              {r.state === 'indexing' && <Spinner className="h-3.5 w-3.5 text-churn" />}
              {r.state === 'error' && <span className="h-2 w-2 shrink-0 rounded-full bg-removed" />}
            </button>
          )
        })}
      </nav>

      <div className="border-t border-base-600/50 p-3">
        <button className="btn-primary w-full" onClick={onAdd}>
          <Plus className="h-4 w-4" /> Add repository
        </button>
      </div>
    </aside>
  )
}
