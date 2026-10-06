/** Fetch wrapper with a tiny in-memory cache and abort-safe hooks. */

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let resp: Response
  try {
    resp = await fetch(path, init)
  } catch {
    throw new ApiError(0, 'Network error — is the backend running?')
  }
  if (!resp.ok) {
    let detail = `Request failed (${resp.status})`
    try {
      const body = await resp.json()
      if (body?.detail) detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
    } catch {
      /* ignore body parse errors */
    }
    throw new ApiError(resp.status, detail)
  }
  return (await resp.json()) as T
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}

/** Query params shared by the metrics/commits endpoints. */
export type QueryParams = Record<string, string | number | string[] | null | undefined>

/**
 * Fetch a filtered repo endpoint. Uses GET while the query string fits in a
 * URL; large manual commit selections switch to the POST variant of the same
 * endpoint so the request never exceeds URL/header limits.
 */
export async function apiQuery<T>(repoId: string, endpoint: 'metrics' | 'commits', params: QueryParams): Promise<T> {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue
    if (Array.isArray(v)) {
      for (const item of v) q.append(k, item)
    } else {
      q.set(k, String(v))
    }
  }
  const qs = q.toString()
  const base = `/api/repos/${repoId}/${endpoint}`
  if (qs.length <= 3500) return api.get<T>(`${base}?${qs}`)
  return api.post<T>(base, params)
}

/** Upload a file with progress via XHR (fetch has no upload progress). */
export function uploadWithProgress(
  path: string,
  file: File,
  onProgress: (pct: number) => void,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', path)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText))
        } catch {
          reject(new ApiError(xhr.status, 'Invalid server response'))
        }
      } else {
        let detail = `Upload failed (${xhr.status})`
        try {
          const body = JSON.parse(xhr.responseText)
          if (body?.detail) detail = body.detail
        } catch {
          /* ignore */
        }
        reject(new ApiError(xhr.status, detail))
      }
    }
    xhr.onerror = () => reject(new ApiError(0, 'Network error during upload'))
    const form = new FormData()
    form.append('file', file)
    xhr.send(form)
  })
}
