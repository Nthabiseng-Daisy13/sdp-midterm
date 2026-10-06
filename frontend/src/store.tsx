/** Global app state: navigation (hash-routed), filters, toasts, data cache. */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { api, apiQuery, QueryParams } from './api'
import { Filters, Job, RepoInfo, emptyFilters } from './types'

export type Tab = 'overview' | 'commits' | 'authors'

interface NavState {
  repoId: string | null
  tab: Tab
  path: string
  filters: Filters
}

interface Toast {
  id: number
  kind: 'error' | 'info' | 'success'
  message: string
}

interface AppState extends NavState {
  repos: RepoInfo[]
  reposLoading: boolean
  toasts: Toast[]
  /** Bumped when server-side data changes outside the URL (e.g. author merges). */
  dataVersion: number
  bumpData: () => void
  setTab: (t: Tab) => void
  setPath: (p: string) => void
  setFilters: (f: Filters) => void
  openRepo: (id: string | null) => void
  refreshRepos: () => void
  toast: (kind: Toast['kind'], message: string) => void
  dismissToast: (id: number) => void
}

const AppCtx = createContext<AppState | null>(null)

// -- hash (de)serialization --------------------------------------------------

function parseHash(): NavState {
  const raw = window.location.hash.replace(/^#/, '')
  const params = new URLSearchParams(raw)
  const repoId = params.get('r')
  const tab = (params.get('t') as Tab) || 'overview'
  const path = params.get('p') || ''
  const authors = params.get('a') ? params.get('a')!.split('\u001e').filter(Boolean) : []
  const from = params.get('f')
  const to = params.get('e')
  const commits = params.get('c') ? params.get('c')!.split(',').filter(Boolean) : null
  return { repoId, tab, path, filters: { authors, from, to, commits } }
}

function serializeHash(s: NavState): string {
  if (!s.repoId) return ''
  const params = new URLSearchParams()
  params.set('r', s.repoId)
  if (s.tab !== 'overview') params.set('t', s.tab)
  if (s.path) params.set('p', s.path)
  const f = s.filters
  if (f.authors.length) params.set('a', f.authors.join('\u001e'))
  if (f.from) params.set('f', f.from)
  if (f.to) params.set('e', f.to)
  if (f.commits && f.commits.length) params.set('c', f.commits.join(','))
  return params.toString()
}

// -- context provider ---------------------------------------------------------

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [nav, setNav] = useState<NavState>(parseHash)
  const [repos, setRepos] = useState<RepoInfo[]>([])
  const [reposLoading, setReposLoading] = useState(true)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [dataVersion, setDataVersion] = useState(0)
  const toastId = useRef(0)

  const bumpData = useCallback(() => setDataVersion((v) => v + 1), [])

  const refreshRepos = useCallback(() => {
    api
      .get<RepoInfo[]>('/api/repos')
      .then(setRepos)
      .catch(() => setRepos([]))
      .finally(() => setReposLoading(false))
  }, [])

  useEffect(() => {
    refreshRepos()
  }, [refreshRepos])

  // keep the URL in sync (replace, not push, to avoid history spam)
  useEffect(() => {
    const next = '#' + serializeHash(nav)
    if (window.location.hash !== next) {
      window.history.replaceState(null, '', next || '#')
    }
  }, [nav])

  // react to browser navigation (back/forward)
  useEffect(() => {
    const onHash = () => setNav(parseHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const toast = useCallback((kind: Toast['kind'], message: string) => {
    const id = ++toastId.current
    setToasts((t) => [...t, { id, kind, message }])
    window.setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id))
    }, kind === 'error' ? 7000 : 4000)
  }, [])

  const dismissToast = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id))
  }, [])

  const value = useMemo<AppState>(
    () => ({
      ...nav,
      repos,
      reposLoading,
      toasts,
      dataVersion,
      bumpData,
      setTab: (tab) => setNav((n) => ({ ...n, tab })),
      setPath: (path) => setNav((n) => ({ ...n, path, tab: 'overview' })),
      setFilters: (filters) => setNav((n) => ({ ...n, filters })),
      openRepo: (repoId) =>
        setNav({ repoId, tab: 'overview', path: '', filters: { ...emptyFilters } }),
      refreshRepos,
      toast,
      dismissToast,
    }),
    [nav, repos, reposLoading, toasts, dataVersion, bumpData, refreshRepos, toast, dismissToast],
  )

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>
}

export function useApp(): AppState {
  const ctx = useContext(AppCtx)
  if (!ctx) throw new Error('useApp outside provider')
  return ctx
}

// -- data fetching helpers ----------------------------------------------------

/** Fetch JSON with abort handling; returns [data, error]. */
export function useFetch<T>(url: string | null, deps: unknown[] = []): {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => void
} {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState<boolean>(!!url)
  const [tick, setTick] = useState(0)
  const first = useRef(true)

  useEffect(() => {
    if (!url) {
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    if (first.current) {
      first.current = false
    }
    const ctrl = new AbortController()
    let alive = true
    setLoading(true)
    api
      .get<T>(url)
      .then((d) => {
        if (alive) {
          setData(d)
          setError(null)
        }
      })
      .catch((e: Error) => {
        if (alive) setError(e.message)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
      ctrl.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, tick, ...deps])

  return { data, error, loading, reload: () => setTick((t) => t + 1) }
}

/**
 * Like useFetch, but for filtered repo queries (metrics/commits). Falls back
 * to a POST request when the filter set is too large for a GET URL (e.g.
 * hundreds of manually selected commits).
 */
export function useApiQuery<T>(
  repoId: string | null,
  endpoint: 'metrics' | 'commits',
  params: QueryParams,
  deps: unknown[] = [],
): { data: T | null; error: string | null; loading: boolean } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState<boolean>(!!repoId)
  const key = JSON.stringify(params)

  useEffect(() => {
    if (!repoId) {
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    apiQuery<T>(repoId, endpoint, params)
      .then((d) => {
        if (alive) {
          setData(d)
          setError(null)
        }
      })
      .catch((e: Error) => {
        if (alive) setError(e.message)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, endpoint, key, ...deps])

  return { data, error, loading }
}

/** Poll a job until it finishes; calls onDone when terminal. */
export function useJobPoller(jobId: string | null, onDone: (job: Job) => void) {
  const [job, setJob] = useState<Job | null>(null)
  const doneRef = useRef(onDone)
  doneRef.current = onDone

  useEffect(() => {
    if (!jobId) {
      setJob(null)
      return
    }
    let alive = true
    let timer = 0
    const poll = async () => {
      try {
        const j = await api.get<Job>(`/api/jobs/${jobId}`)
        if (!alive) return
        setJob(j)
        if (j.state !== 'running') {
          doneRef.current(j)
          return
        }
      } catch {
        /* transient errors: keep polling */
      }
      if (alive) timer = window.setTimeout(poll, 1200)
    }
    poll()
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [jobId])

  return job
}
