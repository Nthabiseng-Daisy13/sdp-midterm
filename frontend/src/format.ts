/** Formatting helpers and stable author colors. */

export function fmtNum(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1) + 'M'
  if (abs >= 10_000) return (n / 1000).toFixed(abs >= 100_000 ? 0 : 1) + 'k'
  return n.toLocaleString('en-US')
}

export function fmtInt(n: number): string {
  return n.toLocaleString('en-US')
}

export function fmtPct(x: number, digits = 1): string {
  return (x * 100).toFixed(digits) + '%'
}

const DATE_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
})

const DATETIME_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

const MONTH_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', year: 'numeric', month: 'short' })

export function fmtDate(ts: number | null | undefined): string {
  return ts ? DATE_FMT.format(new Date(ts * 1000)) : '—'
}

export function fmtDateTime(ts: number | null | undefined): string {
  return ts ? DATETIME_FMT.format(new Date(ts * 1000)) + ' UTC' : '—'
}

export function fmtMonth(ts: number): string {
  return MONTH_FMT.format(new Date(ts * 1000))
}

export function fmtSigned(n: number): string {
  return n > 0 ? `+${fmtNum(n)}` : fmtNum(n)
}

/** Stable color for an author key (tones chosen to stay readable on the light theme). */
const PALETTE = [
  '#C2255C', '#047857', '#B45309', '#BE123C', '#A21CAF', '#2563EB',
  '#0D9488', '#7C3AED', '#CA8A04', '#EA580C', '#4F46E5', '#0891B2',
  '#DB2777', '#65A30D', '#9333EA', '#DC2626',
]

export function authorColor(key: string): string {
  let h = 0
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) >>> 0
  }
  return PALETTE[h % PALETTE.length] as string
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
}

/** Split "first" and extension for the file badge colour. */
const EXT_COLORS: Record<string, string> = {
  py: '#059669', js: '#D97706', ts: '#2563EB', tsx: '#2563EB', jsx: '#D97706',
  c: '#4F46E5', h: '#4F46E5', cpp: '#4F46E5', rs: '#EA580C', go: '#0891B2',
  java: '#BE123C', rb: '#BE123C', md: '#7C5568', json: '#CA8A04', yml: '#7C5568',
  yaml: '#7C5568', toml: '#7C5568', sh: '#65A30D', html: '#BE123C', css: '#A21CAF',
  sql: '#0891B2', lock: '#8A6376', txt: '#7C5568',
}

export function extColor(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  return EXT_COLORS[ext] ?? '#7C5568'
}
