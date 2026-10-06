import { useCallback, useRef, useState } from 'react'
import { Download, FolderArchive, Github, Link2 } from 'lucide-react'
import { api, uploadWithProgress } from '../api'
import { Job } from '../types'
import { useApp } from '../store'
import { Modal, Spinner } from './ui'

type Mode = 'clone' | 'upload'

export function AddRepoModal({ onClose, initialUrl = '' }: { onClose: () => void; initialUrl?: string }) {
  const { toast, refreshRepos, openRepo } = useApp()
  const [mode, setMode] = useState<Mode>(initialUrl ? 'clone' : 'upload')
  const [url, setUrl] = useState(initialUrl)
  const [name, setName] = useState('')
  const [uploadPct, setUploadPct] = useState<number | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const pollJob = useCallback(
    (jobId: string) => {
      const timer = window.setInterval(async () => {
        try {
          const j = await api.get<Job>(`/api/jobs/${jobId}`)
          setJob(j)
          if (j.state === 'done') {
            window.clearInterval(timer)
            setBusy(false)
            refreshRepos()
            if (j.repo_id) {
              openRepo(j.repo_id)
              toast('success', `Repository “${j.repo_name ?? ''}” is ready`)
            }
            onClose()
          } else if (j.state === 'error') {
            window.clearInterval(timer)
            setBusy(false)
            setError(j.error ?? 'Ingestion failed')
            refreshRepos()
          }
        } catch {
          /* keep polling on transient errors */
        }
      }, 1200)
    },
    [refreshRepos, openRepo, toast, onClose],
  )

  const submitClone = async () => {
    setError(null)
    if (!url.trim()) {
      setError('Enter a repository URL')
      return
    }
    setBusy(true)
    try {
      const resp = await api.post<{ job: Job }>('/api/repos/clone', {
        url: url.trim(),
        name: name.trim() || null,
      })
      setJob(resp.job)
      pollJob(resp.job.id)
    } catch (e) {
      setBusy(false)
      setError((e as Error).message)
    }
  }

  const submitUpload = async (file: File) => {
    setError(null)
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setError('Please choose a .zip file (the repository folder including .git)')
      return
    }
    setBusy(true)
    setUploadPct(0)
    try {
      const resp = (await uploadWithProgress('/api/repos/upload', file, setUploadPct)) as { job: Job }
      setUploadPct(null)
      setJob(resp.job)
      pollJob(resp.job.id)
    } catch (e) {
      setBusy(false)
      setUploadPct(null)
      setError((e as Error).message)
    }
  }

  const running = busy || job?.state === 'running'

  return (
    <Modal title="Add repository" onClose={running ? () => {} : onClose}>
      {running ? (
        <div className="space-y-4 py-2">
          <div className="flex items-center gap-3">
            <Spinner className="h-5 w-5 text-churn" />
            <div className="text-sm font-medium">
              {job ? jobStateLabel(job.kind) : 'Uploading zip file…'}
            </div>
          </div>
          {uploadPct !== null && (
            <div className="h-2 overflow-hidden rounded-full bg-base-700">
              <div
                className="h-full rounded-full bg-churn transition-all"
                style={{ width: `${uploadPct}%` }}
              />
            </div>
          )}
          <div className="max-h-48 overflow-y-auto rounded-lg border border-base-600/60 bg-base-900/60 p-3 font-mono text-[11px] leading-relaxed text-ink-muted">
            {(job?.log ?? ['Starting…']).map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <button
              className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors ${
                mode === 'clone'
                  ? 'border-churn/50 bg-churn/10 text-churn'
                  : 'border-base-600/60 text-ink-muted hover:bg-base-700/40'
              }`}
              onClick={() => setMode('clone')}
            >
              <Link2 className="h-4 w-4" /> Clone URL
            </button>
            <button
              className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors ${
                mode === 'upload'
                  ? 'border-churn/50 bg-churn/10 text-churn'
                  : 'border-base-600/60 text-ink-muted hover:bg-base-700/40'
              }`}
              onClick={() => setMode('upload')}
            >
              <FolderArchive className="h-4 w-4" /> Upload ZIP
            </button>
          </div>

          {mode === 'clone' ? (
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-muted">Repository URL</label>
                <input
                  className="input w-full"
                  placeholder="https://github.com/DaveGamble/cJSON.git"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submitClone()}
                  autoFocus
                />
                <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
                  The repository is cloned with full history, then indexed once. http(s), git://, ssh://
                  and git@host:path URLs are supported.
                </p>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-muted">
                  Display name <span className="text-ink-faint">(optional)</span>
                </label>
                <input
                  className="input w-full"
                  placeholder="Defaults to the repository name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <button className="btn-primary w-full" onClick={submitClone}>
                <Github className="h-4 w-4" /> Clone repository
              </button>
            </div>
          ) : (
            <div
              className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-base-500/70 bg-base-900/40 px-4 py-10 text-center transition-colors hover:border-churn/50 hover:bg-churn/5"
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                const f = e.dataTransfer.files[0]
                if (f) void submitUpload(f)
              }}
            >
              <Download className="h-6 w-6 text-ink-faint" />
              <div className="text-sm font-medium">Drop a repository zip here</div>
              <div className="max-w-xs text-[11px] leading-relaxed text-ink-faint">
                The zip must contain the repository folder <span className="font-mono">.git</span>{' '}
                directory (or be a bare-repository zip). A GitHub “Download ZIP” export has no history.
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".zip"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void submitUpload(f)
                }}
              />
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-removed/30 bg-removed/10 px-3 py-2 text-xs leading-relaxed text-ink">
              {error}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

function jobStateLabel(kind: Job['kind']): string {
  switch (kind) {
    case 'clone':
      return 'Cloning repository…'
    case 'upload':
      return 'Extracting and indexing…'
    default:
      return 'Indexing…'
  }
}
