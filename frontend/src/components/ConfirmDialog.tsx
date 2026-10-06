import { useEffect, useRef, type ReactNode } from 'react'

interface Props {
  open: boolean
  title: string
  children: ReactNode
  confirmLabel: string
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
}

/** Native modal <dialog>: bottom sheet on phones, centred box on wider screens. Focus is trapped by the browser. */
export function ConfirmDialog({ open, title, children, confirmLabel, busy, onCancel, onConfirm }: Props) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const d = ref.current
    if (!d || typeof d.showModal !== 'function') return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby="confirm-title"
      onCancel={(e) => {
        e.preventDefault() // we control `open`
        if (!busy) onCancel()
      }}
    >
      <div className="sheet__body">
        <h2 id="confirm-title">{title}</h2>
        <div className="muted">{children}</div>
        <div className="sheet__actions">
          <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--danger" onClick={onConfirm} disabled={busy}>
            {busy ? 'Ending…' : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  )
}
