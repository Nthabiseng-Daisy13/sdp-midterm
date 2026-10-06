/** Landing view: repository cards, quick-clone shortcuts, delete management. */
import { useState } from 'react'
import { ArrowRight, FolderArchive, Link2, Plus, Trash2 } from 'lucide-react'
import { api } from '../api'
import { useApp } from '../store'
import { RepoInfo } from '../types'
import { fmtDate, fmtInt, fmtNum } from '../format'
import { ConfirmModal, Spinner } from './ui'

const QUICK_CLONES = [
  { name: 'cJSON', url: 'https://github.com/DaveGamble/cJSON.git' },
  { name: 'Redis', url: 'https://github.com/redis/redis.git' },
  { name: 'Git', url: 'https://github.com/git/git.git' },
]

export function HomeView({
  onAdd,
  onQuickClone,
}: {
  onAdd: () => void
  onQuickClone: (url: string) => void
}) {
  const { repos, reposLoading, openRepo, refreshRepos, toast } = useApp()
  const [deleteTarget, setDeleteTarget] = useState<RepoInfo | null>(null)
  const [deleting, setDeleting] = useState(false)

  const doDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await api.del(`/api/repos/${deleteTarget.id}`)
      toast('success', `Removed “${deleteTarget.name}”`)
      setDeleteTarget(null)
      refreshRepos()
    } catch (e) {
      toast('error', `Could not remove repository: ${(e as Error).message}`)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-10">
        {/* Hero */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight">Repo Analysis Tool</h1>
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ink-muted">
            Add a repository — by remote URL or a zip containing its{' '}
            <span className="font-mono text-ink">.git</span> directory — and explore file, directory,
            repository, commit-set and author metrics: added/removed lines, growth, churn,
            modifications and ownership, filtered by author, path, time window or a manual commit
            selection.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button className="btn-primary" onClick={onAdd}>
              <Plus className="h-4 w-4" /> Add repository
            </button>
            <span className="text-xs text-ink-faint">or try a reference repo:</span>
            {QUICK_CLONES.map((q) => (
              <button
                key={q.name}
                className="chip transition-colors hover:border-churn/50 hover:text-churn"
                title={q.url}
                onClick={() => onQuickClone(q.url)}
              >
                {q.name}
              </button>
            ))}
          </div>
        </div>

        {/* Repository cards */}
        {reposLoading ? (
          <div className="flex items-center gap-2 py-10 text-sm text-ink-faint">
            <Spinner className="h-4 w-4" /> Loading repositories…
          </div>
        ) : repos.length === 0 ? (
          <div className="panel flex flex-col items-center gap-3 px-6 py-14 text-center">
            <div className="text-sm font-medium">No repositories yet</div>
            <div className="max-w-md text-xs leading-relaxed text-ink-faint">
              Clone a remote URL or upload a zip export of a repository folder. RAT indexes the full
              history once and keeps it cached, so switching views and filters stays fast even on
              large repositories.
            </div>
            <button className="btn-primary mt-1" onClick={onAdd}>
              <Plus className="h-4 w-4" /> Add your first repository
            </button>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {repos.map((r) => (
              <RepoCard key={r.id} repo={r} onOpen={() => openRepo(r.id)} onDelete={() => setDeleteTarget(r)} />
            ))}
          </div>
        )}
      </div>

      {deleteTarget && (
        <ConfirmModal
          title={`Remove “${deleteTarget.name}”?`}
          body="This deletes the stored clone and all cached metrics from RAT. The original remote
            repository is unaffected; re-adding it will clone it again."
          confirmLabel="Remove repository"
          danger
          busy={deleting}
          onConfirm={() => void doDelete()}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  )
}

function RepoCard({
  repo,
  onOpen,
  onDelete,
}: {
  repo: RepoInfo
  onOpen: () => void
  onDelete: () => void
}) {
  const ready = repo.state === 'ready' && repo.stats
  return (
    <div
      className={`panel group relative cursor-pointer p-4 transition-colors hover:border-churn/40 ${
        repo.state === 'error' ? 'border-removed/30' : ''
      }`}
      onClick={onOpen}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{repo.name}</div>
          <div className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-ink-faint">
            {repo.source.type === 'clone' ? (
              <Link2 className="h-3 w-3 shrink-0" />
            ) : (
              <FolderArchive className="h-3 w-3 shrink-0" />
            )}
            <span className="truncate" title={repo.source.detail}>
              {repo.source.detail}
            </span>
          </div>
        </div>
        <button
          className="btn-ghost -mr-1 -mt-1 p-1.5 opacity-0 transition-opacity group-hover:opacity-100"
          title="Remove repository"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
        >
          <Trash2 className="h-3.5 w-3.5 text-removed" />
        </button>
      </div>

      <div className="mt-3">
        {repo.state === 'indexing' && (
          <div className="flex items-center gap-2 py-1.5 text-xs text-churn">
            <Spinner className="h-3.5 w-3.5" /> Indexing…
          </div>
        )}
        {repo.state === 'error' && (
          <div className="py-1.5 text-xs leading-snug text-removed" title={repo.error ?? ''}>
            Failed to index
            {repo.error ? `: ${repo.error.split('\n')[0]}` : ''}
          </div>
        )}
        {ready && (
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
            <CardStat label="Commits" value={fmtInt(repo.stats!.commits)} />
            <CardStat label="Files" value={fmtInt(repo.stats!.files)} />
            <CardStat label="Churn" value={fmtNum(repo.stats!.churn)} />
            <CardStat
              label="Lines"
              value={`${fmtNum(repo.stats!.added)} / ${fmtNum(repo.stats!.removed)}`}
            />
            <div className="col-span-2 mt-1 text-[11px] text-ink-faint">
              {fmtDate(repo.stats!.first_ts)} → {fmtDate(repo.stats!.last_ts)}
            </div>
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center gap-1 text-xs font-medium text-churn opacity-0 transition-opacity group-hover:opacity-100">
        Open dashboard <ArrowRight className="h-3.5 w-3.5" />
      </div>
    </div>
  )
}

function CardStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-ink-faint">{label}</div>
      <div className="tabular-nums">{value}</div>
    </div>
  )
}
