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

/** Stable color for an author key. */
const PALETTE = [
  '#38bdf8', '#34d399', '#fbbf24', '#fb7185', '#a78bfa', '#f472b6',
  '#4ade80', '#22d3ee', '#facc15', '#fb923c', '#818cf8', '#2dd4bf',
  '#e879f9', '#93c5fd', '#fda4af', '#86efac',
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
  py: '#4ade80', js: '#fbbf24', ts: '#38bdf8', tsx: '#38bdf8', jsx: '#fbbf24',
  c: '#818cf8', h: '#818cf8', cpp: '#818cf8', rs: '#fb923c', go: '#22d3ee',
  java: '#fb7185', rb: '#fb7185', md: '#a8b3c5', json: '#facc15', yml: '#a8b3c5',
  yaml: '#a8b3c5', toml: '#a8b3c5', sh: '#86efac', html: '#fb7185', css: '#a78bfa',
  sql: '#22d3ee', lock: '#5b6b84', txt: '#8194ad',
}

export function extColor(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  return EXT_COLORS[ext] ?? '#8194ad'
}
