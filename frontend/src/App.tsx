/** App shell: sidebar + repo dashboard (header, filter bar, tabs). */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { FolderArchive, GitBranch, History, ListChecks, Trash2, Users } from 'lucide-react'
import { api } from './api'
import { AppProvider, useApp, useJobPoller } from './store'
import { Job, RepoInfo } from './types'
import { AddRepoModal } from './components/AddRepoModal'
import { AuthorsTab } from './components/AuthorsTab'
import { CommitsTab } from './components/CommitsTab'
import { FilterBar } from './components/FilterBar'
import { HomeView } from './components/HomeView'
import { OverviewTab } from './components/OverviewTab'
import { Sidebar } from './components/Sidebar'
import { ConfirmModal, EmptyState, ErrorBox, Spinner, Toasts, useClickOutside } from './components/ui'
import type { Tab } from './store'

export default function App() {
  return (
    <AppProvider>
      <Shell />
      <Toasts />
    </AppProvider>
  )
}

function Shell() {
  const { repos, refreshRepos, repoId } = useApp()
  const [addOpen, setAddOpen] = useState(false)
  const [addUrl, setAddUrl] = useState('')

  // Poll while any repository is still being ingested/indexed.
  const anyIndexing = repos.some((r) => r.state === 'indexing')
  useEffect(() => {
    if (!anyIndexing) return
    const t = window.setInterval(refreshRepos, 2500)
    return () => window.clearInterval(t)
  }, [anyIndexing, refreshRepos])

  const openAdd = (url = '') => {
    setAddUrl(url)
    setAddOpen(true)
  }

  return (
    <div className="flex h-full">
      <Sidebar onAdd={() => openAdd()} />
      <main className="flex h-full min-w-0 flex-1 flex-col">
        {addOpen && <AddRepoModal initialUrl={addUrl} onClose={() => setAddOpen(false)} />}
        {repoId ? (
          <RepoView />
        ) : (
          <HomeView onAdd={() => openAdd()} onQuickClone={(url) => openAdd(url)} />
        )}
      </main>
    </div>
  )
}

function RepoView() {
  const { repoId, tab, setTab, repos, refreshRepos, openRepo, toast } = useApp()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const repo = repos.find((r) => r.id === repoId)

  if (!repo) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <EmptyState
          title="Repository not found"
          hint="It may have been removed. Pick another repository from the sidebar."
          action={
            <button className="btn-ghost mt-1 text-xs" onClick={() => openRepo(null)}>
              ← Back to home
            </button>
          }
        />
      </div>
    )
  }

  const doDelete = async () => {
    if (!repo) return
    setDeleting(true)
    try {
      await api.del(`/api/repos/${repo.id}`)
      toast('success', `Removed “${repo.name}”`)
      openRepo(null)
      refreshRepos()
    } catch (e) {
      toast('error', `Could not remove repository: ${(e as Error).message}`)
    } finally {
      setDeleting(false)
      setDeleteOpen(false)
    }
  }

  const tabs: { id: Tab; label: string; icon: ReactNode }[] = [
    { id: 'overview', label: 'Overview', icon: <History className="h-3.5 w-3.5" /> },
    { id: 'commits', label: 'Commits', icon: <ListChecks className="h-3.5 w-3.5" /> },
    { id: 'authors', label: 'Authors', icon: <Users className="h-3.5 w-3.5" /> },
  ]

  return (
    <>
      <header className="shrink-0 border-b border-base-600/50 bg-base-900/95">
        <div className="flex flex-wrap items-center gap-3 px-5 py-3">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold leading-tight tracking-tight">{repo.name}</h1>
            <div className="flex items-center gap-1.5 text-[11px] text-ink-faint">
              {repo.source.type === 'clone' ? (
                <GitBranch className="h-3 w-3 shrink-0" />
              ) : (
                <FolderArchive className="h-3 w-3 shrink-0" />
              )}
              <span className="max-w-[28rem] truncate" title={repo.source.detail}>
                {repo.source.detail}
              </span>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <RefControl repo={repo} />
            <button
              className="btn-ghost px-2 py-1.5 text-xs text-removed hover:bg-removed/10"
              title="Remove this repository"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <nav className="flex items-center gap-1 px-4">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors ${
                tab === t.id
                  ? 'border-churn font-semibold text-ink'
                  : 'border-transparent font-medium text-ink-faint hover:text-ink-muted'
              }`}
              onClick={() => setTab(t.id)}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {repo.state === 'indexing' ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
            <Spinner className="h-7 w-7 text-churn" />
            <div className="text-sm font-medium">Indexing repository…</div>
            <div className="max-w-sm text-xs leading-relaxed text-ink-faint">
              The full commit history is parsed once per reference and cached — this can take a
              moment for large repositories. The dashboard opens automatically when it&apos;s ready.
            </div>
          </div>
        ) : repo.state === 'error' ? (
          <div className="space-y-3 p-5">
            <ErrorBox message={`Indexing failed: ${repo.error ?? 'unknown error'}`} />
            <div className="flex gap-2">
              <button className="btn-ghost text-xs" onClick={() => openRepo(null)}>
                ← Back to home
              </button>
              <button
                className="btn border border-removed/40 bg-removed/10 text-xs text-removed"
                onClick={() => setDeleteOpen(true)}
              >
                Remove repository
              </button>
            </div>
          </div>
        ) : (
          <>
            {tab !== 'authors' && <FilterBar totalCommits={repo.stats?.commits ?? null} />}
            {tab === 'overview' && <OverviewTab />}
            {tab === 'commits' && <CommitsTab />}
            {tab === 'authors' && <AuthorsTab />}
          </>
        )}
      </div>

      {deleteOpen && (
        <ConfirmModal
          title={`Remove “${repo.name}”?`}
          body="This deletes the stored clone and all cached metrics from RAT. The original remote
            repository is unaffected; re-adding it will clone it again."
          confirmLabel="Remove repository"
          danger
          busy={deleting}
          onConfirm={() => void doDelete()}
          onClose={() => setDeleteOpen(false)}
        />
      )}
    </>
  )
}

/** Popover to change the reference (branch/tag/commit) metrics are computed from. */
function RefControl({ repo }: { repo: RepoInfo }) {
  const { refreshRepos, toast, bumpData } = useApp()
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(repo.ref)
  const [jobId, setJobId] = useState<string | null>(null)
  const ref = useClickOutside<HTMLDivElement>(() => setOpen(false))

  useJobPoller(jobId, (job: Job) => {
    setJobId(null)
    if (job.state === 'done') {
      toast('success', `Reference set to ${value.trim() || 'HEAD'} — repository re-indexed`)
      refreshRepos()
      bumpData()
      setOpen(false)
    } else {
      toast('error', `Could not switch reference: ${job.error ?? 'unknown error'}`)
    }
  })

  const apply = async () => {
    try {
      const resp = await api.post<{ job: Job }>(`/api/repos/${repo.id}/ref`, {
        ref: value.trim() || 'HEAD',
      })
      setJobId(resp.job.id)
    } catch (e) {
      toast('error', (e as Error).message)
    }
  }

  const busy = jobId !== null

  return (
    <div className="relative" ref={ref}>
      <button
        className="btn border border-base-600/70 bg-base-800 text-xs text-ink-muted hover:text-ink"
        onClick={() => setOpen((v) => !v)}
        title="Change the reference commit (branch, tag or hash) that metrics are computed from"
      >
        <GitBranch className="h-3.5 w-3.5 text-churn" />
        {repo.ref}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-40 mt-1.5 w-72 rounded-xl border border-base-500/70 bg-base-850 p-3 shadow-xl">
          <label className="mb-1 block text-[11px] font-medium text-ink-muted">
            Reference — branch, tag or commit hash
          </label>
          <input
            className="input w-full font-mono text-xs"
            placeholder="HEAD"
            value={value}
            autoFocus
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void apply()}
          />
          <div className="mt-2.5 flex justify-end gap-2">
            <button className="btn-ghost text-xs" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </button>
            <button className="btn-primary text-xs" disabled={busy} onClick={() => void apply()}>
              {busy ? 'Switching…' : 'Apply'}
            </button>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
            H̄ is the set of non-merge commits reachable from this reference. Already-indexed
            references are re-used from cache.
          </p>
        </div>
      )}
    </div>
  )
}
