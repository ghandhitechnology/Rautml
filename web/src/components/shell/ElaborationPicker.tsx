/* ElaborationPicker — the pill chip to the left of the model pebble that
 * expands upward into the three audience levels (Undergraduate / Bachelor's /
 * Doctor). It sets how much the next answer explains domain-specific terms —
 * the path to the conclusion, never the conclusion itself.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useElaboration, useStore } from '../../state/store'
import type { ElaborationLevel } from '../../lib/types'
import { cx } from '../../lib/utils'
import { EASE } from '../../lib/motion'
import './ElaborationPicker.css'

interface ElaborationOption {
  id: ElaborationLevel
  name: string
  description: string
}

const OPTIONS: ElaborationOption[] = [
  {
    id: 'undergraduate',
    name: 'Undergraduate',
    description: 'Explains most domain terms, with room set aside to make things approachable',
  },
  {
    id: 'bachelors',
    name: "Bachelor's",
    description: 'Brief one-or-two-sentence reminders of domain terms as they appear',
  },
  {
    id: 'doctor',
    name: 'Doctor',
    description: 'Domain terms used directly — no extra explanations on the way',
  },
]

export interface ElaborationPickerProps {
  className?: string
}

export function ElaborationPicker({ className }: ElaborationPickerProps) {
  const elaboration = useElaboration()
  const setElaboration = useStore((s) => s.setElaboration)

  // Per-instance: the outside-pointerdown listener below closes this popover
  // whenever any other composer chip is clicked.
  const [open, setOpen] = useState(false)

  const rootRef = useRef<HTMLDivElement>(null)
  const chipRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  /* The selected option carries this ref so opening the popover can move focus
   * straight onto the current level (the DownloadMenu pattern: focus into the
   * menu on open, back to the chip on Escape). */
  const selectedOptionRef = useRef<HTMLButtonElement>(null)
  const dialogId = useId()

  const close = useCallback(
    (refocus = false) => {
      setOpen(false)
      if (refocus) chipRef.current?.focus()
    },
    [setOpen],
  )

  // Outside click / Escape. Opening moves focus into the popover.
  useEffect(() => {
    if (!open) return
    const focusFrame = window.requestAnimationFrame(() => {
      const target = selectedOptionRef.current ?? popRef.current?.querySelector('button')
      target?.focus()
    })
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, close])

  const selected = OPTIONS.find((o) => o.id === elaboration) ?? OPTIONS[1]!

  return (
    <div ref={rootRef} className={cx('rml-elab', className)}>
      <button
        ref={chipRef}
        type="button"
        className={cx('rml-elab__chip', open && 'is-open')}
        onClick={() => setOpen(!open)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={dialogId}
        title="Choose how much answers explain domain terms"
      >
        <span className="rml-elab__chip-label">{selected.name}</span>
        <svg className="rml-elab__chevron" viewBox="0 0 10 6" aria-hidden="true">
          <path d="M1 1l4 4 4-4" />
        </svg>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            ref={popRef}
            id={dialogId}
            className="rml-elab__pop"
            role="dialog"
            aria-label="Elaboration level"
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 6 }}
            transition={{ duration: 0.22, ease: EASE }}
          >
            <div className="rml-elab__head">Explain terms for a…</div>
            <ul className="rml-elab__list" role="listbox" aria-label="Elaboration level">
              {OPTIONS.map((option) => {
                const isSelected = option.id === elaboration
                return (
                  <li key={option.id} role="option" aria-selected={isSelected}>
                    <button
                      ref={isSelected ? selectedOptionRef : undefined}
                      type="button"
                      className={cx('rml-elab__option', isSelected && 'is-selected')}
                      onClick={() => {
                        setElaboration(option.id)
                        close(true)
                      }}
                    >
                      <span className="rml-elab__option-main">
                        <span className="rml-elab__option-name">{option.name}</span>
                        <span className="rml-elab__option-desc">{option.description}</span>
                      </span>
                      {isSelected && (
                        <svg className="rml-elab__check" viewBox="0 0 14 14" aria-hidden="true">
                          <path d="M2.5 7.5l3 3 6-7" />
                        </svg>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default ElaborationPicker
