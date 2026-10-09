import { useEffect, useState } from 'react'
import type { PasswordRequest } from '../sql/import'

interface Props {
  request: PasswordRequest
  onSubmit: (password: string) => void
  onSkip: () => void
}

export default function PasswordPrompt({ request, onSubmit, onSkip }: Props) {
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const wrong = request.attempt > 0
  const archive = request.archive.split('/').pop() ?? request.archive
  const entry = request.entry.split('/').pop() ?? request.entry

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onSkip()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onSkip])

  return (
    <div className="modal-backdrop">
      <form
        className="modal modal--compact"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pw-title"
        onSubmit={(e) => {
          e.preventDefault()
          if (password) onSubmit(password)
        }}
      >
        <h2 id="pw-title" className="pw-title">
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
            <rect x="4" y="10" width="16" height="11" rx="2" />
            <path d="M8 10V7a4 4 0 0 1 8 0v3" fill="none" />
          </svg>
          Password required
        </h2>
        <p>
          <span className="mono strong">{archive}</span> contains password-protected files, starting with{' '}
          <span className="mono">{entry}</span>.
        </p>
        <label className="field">
          <span>Password</span>
          <input
            autoFocus
            type={show ? 'text' : 'password'}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={password}
            aria-invalid={wrong}
            aria-describedby={wrong ? 'pw-error' : undefined}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {wrong && (
          <p id="pw-error" className="form-error" role="alert">
            Incorrect password{request.attempt > 1 ? ` (${request.attempt} attempts)` : ''}. Try again.
          </p>
        )}
        <label className="check">
          <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
          Show password
        </label>
        <p className="muted small">
          Decryption happens in this browser tab. The password is not stored, and schemas from protected files are not saved for the
          next visit.
        </p>
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onSkip}>
            Skip protected files
          </button>
          <button type="submit" className="primary" disabled={!password}>
            Unlock
          </button>
        </div>
      </form>
    </div>
  )
}
