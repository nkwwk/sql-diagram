import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

export interface MenuItem {
  label: ReactNode
  onSelect: () => void
  active?: boolean
  disabled?: boolean
  danger?: boolean
}

interface Props {
  label: string
  items: (MenuItem | 'separator')[]
  /** Button content; defaults to a "more" icon. */
  trigger?: ReactNode
  className?: string
}

/** A small overflow menu. On phones it opens as a bottom sheet. */
export default function Menu({ label, items, trigger, className }: Props) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const id = useId()

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className={`menu${className ? ` ${className}` : ''}`} ref={root}>
      <button
        className={`menu__trigger${open ? ' is-on' : ''}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        title={label}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger ?? (
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
            <circle cx="5" cy="12" r="1.8" />
            <circle cx="12" cy="12" r="1.8" />
            <circle cx="19" cy="12" r="1.8" />
          </svg>
        )}
      </button>
      {open && (
        <>
          <div className="menu__scrim" onClick={() => setOpen(false)} />
          <div className="menu__list" role="menu" id={id} aria-label={label}>
            <div className="menu__title">{label}</div>
            {items.map((item, i) =>
              item === 'separator' ? (
                <div key={i} className="menu__sep" role="separator" />
              ) : (
                <button
                  key={i}
                  role="menuitem"
                  className={`menu__item${item.active ? ' is-active' : ''}${item.danger ? ' is-danger' : ''}`}
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(false)
                    item.onSelect()
                  }}
                >
                  {item.label}
                  {item.active && <span className="menu__check" aria-hidden>✓</span>}
                </button>
              ),
            )}
          </div>
        </>
      )}
    </div>
  )
}
