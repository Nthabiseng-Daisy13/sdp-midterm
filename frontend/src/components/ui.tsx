/** Small shared UI building blocks. */
import React, { useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Info, Loader2, X } from 'lucide-react'
import { useApp } from '../store'

export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return <Loader2 className={`animate-spin ${className}`} />
}

export function Modal({
  title,
  children,
  onClose,
  width = 'max-w-lg',
}: {
  title: string
  children: React.ReactNode
  onClose: () => void
  width?: string
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#46202f]/45 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className={`panel w-full ${width} max-h-[85vh] overflow-y-auto p-5`}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">{title}</h2>
          <button className="btn-ghost -mr-1 -mt-1 p-1" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-base-700/60 ${className}`} />
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: React.ReactNode
  title: string
  hint?: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon && <div className="text-ink-faint">{icon}</div>}
      <div className="text-sm font-medium text-ink-muted">{title}</div>
      {hint && <div className="max-w-sm text-xs text-ink-faint">{hint}</div>}
      {action}
    </div>
  )
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-removed/30 bg-removed/10 px-4 py-3 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-removed" />
      <div className="flex-1">
        <div className="text-ink">{message}</div>
        {onRetry && (
          <button className="btn-ghost mt-1 px-0 text-xs" onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    </div>
  )
}

export function Toasts() {
  const { toasts, dismissToast } = useApp()
  if (toasts.length === 0) return null
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm shadow-lg backdrop-blur ${
            t.kind === 'error'
              ? 'border-removed/40 bg-base-850/95 text-ink'
              : t.kind === 'success'
                ? 'border-added/40 bg-base-850/95 text-ink'
                : 'border-base-500 bg-base-850/95 text-ink'
          }`}
        >
          {t.kind === 'error' ? (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-removed" />
          ) : t.kind === 'success' ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-added" />
          ) : (
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-churn" />
          )}
          <div className="flex-1 leading-snug">{t.message}</div>
          <button className="text-ink-faint hover:text-ink" onClick={() => dismissToast(t.id)}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}

/** Inline horizontal bar showing a value relative to a max (for tables). */
export function MiniBar({
  value,
  max,
  color,
  className = '',
}: {
  value: number
  max: number
  color: string
  className?: string
}) {
  const pct = max > 0 ? Math.max(1.5, (Math.abs(value) / max) * 100) : 0
  return (
    <div className={`h-1.5 w-full overflow-hidden rounded-full bg-base-700/60 ${className}`}>
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
    </div>
  )
}

/** Stacked ownership bar (segments sum to ~100%). */
export function StackedBar({
  segments,
  height = 'h-2',
}: {
  segments: { key: string; value: number; color: string; label: string }[]
  height?: string
}) {
  const total = segments.reduce((s, x) => s + x.value, 0)
  if (total <= 0) {
    return <div className={`${height} w-full rounded-full bg-base-700/60`} />
  }
  return (
    <div className={`flex ${height} w-full overflow-hidden rounded-full bg-base-700/60`}>
      {segments.map((s) => (
        <div
          key={s.key}
          title={`${s.label}: ${((s.value / total) * 100).toFixed(1)}%`}
          style={{ width: `${(s.value / total) * 100}%`, background: s.color }}
        />
      ))}
    </div>
  )
}

/** Author avatar with stable color. */
export function Avatar({ name, color, size = 'h-6 w-6' }: { name: string; color: string; size?: string }) {
  const label = name.trim().split(/\s+/)
  const text =
    label.length === 1 ? label[0]!.slice(0, 2).toUpperCase() : (label[0]![0]! + label[label.length - 1]![0]!).toUpperCase()
  return (
    <div
      className={`${size} flex shrink-0 items-center justify-center rounded-full text-[10px] font-bold`}
      style={{ background: color + '26', color, border: `1px solid ${color}55` }}
    >
      {text}
    </div>
  )
}

/** Tiny sparkline (SVG area path). */
export function Sparkline({
  values,
  color,
  width = 96,
  height = 28,
}: {
  values: number[]
  color: string
  width?: number
  height?: number
}) {
  if (values.length === 0) return <div style={{ width, height }} />
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const span = max - min || 1
  const step = values.length > 1 ? width / (values.length - 1) : width
  const pts = values.map((v, i) => [i * step, height - ((v - min) / span) * (height - 2) - 1] as const)
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `0,${height} ${line} ${width},${height}`
  return (
    <svg width={width} height={height} className="overflow-visible">
      <polygon points={area} fill={color} opacity={0.15} />
      <polyline points={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  )
}

/** Small confirmation dialog for destructive actions. */
export function ConfirmModal({
  title,
  body,
  confirmLabel = 'Confirm',
  danger = false,
  busy = false,
  onConfirm,
  onClose,
}: {
  title: string
  body: React.ReactNode
  confirmLabel?: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Modal title={title} onClose={busy ? () => {} : onClose} width="max-w-md">
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-ink-muted">{body}</p>
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className={`btn ${
              danger
                ? 'border border-removed/40 bg-removed/10 text-removed hover:bg-removed/20'
                : 'btn-primary'
            }`}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  )
}

/** Click-outside hook for dropdown panels. */
export function useClickOutside<T extends HTMLElement>(onOutside: () => void) {
  const ref = useRef<T | null>(null)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onOutside])
  return ref
}

/** Simple debounced value. */
export function useDebounced<T>(value: T, delay = 300): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), delay)
    return () => window.clearTimeout(t)
  }, [value, delay])
  return v
}
