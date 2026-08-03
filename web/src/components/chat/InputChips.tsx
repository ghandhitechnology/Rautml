/* ask_user_input_v0 → a question plus tappable option chips, inline in the thread.
 * Chips stagger in; tapping one resolves the pending input and locks the set:
 * the chosen chip fills with the accent, the rest recede. */

import { useState } from 'react'
import { motion } from 'framer-motion'
import { EASE } from '../../lib/motion'
import { cx } from '../../lib/utils'
import type { InputRequest } from '../../lib/types'
import { useStore } from '../../state/store'
import { Icon } from './icons'
import './InputChips.css'

export interface InputChipsProps {
  request: InputRequest
  /** Defaults to the store's `resolveInput`. */
  onResolve?: (value: string) => void
  compact?: boolean
  className?: string
}

export function InputChips({ request, onResolve, compact = false, className }: InputChipsProps) {
  const resolveInput = useStore((s) => s.resolveInput)
  const [optimistic, setOptimistic] = useState<string | null>(null)

  const chosen = request.resolved ? (request.value ?? optimistic) : optimistic
  const locked = request.resolved || optimistic !== null
  const options = request.options.length ? request.options : ['Continue']

  const pick = (value: string) => {
    if (locked) return
    setOptimistic(value)
    if (onResolve) onResolve(value)
    else void resolveInput(request.id, value)
  }

  return (
    <motion.div
      className={cx('rml-chips', compact && 'rml-chips--compact', locked && 'is-locked', className)}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: EASE }}
    >
      <div className="rml-chips__head">
        <span className="rml-chips__glyph" aria-hidden="true">
          <Icon name="question" size={14} />
        </span>
        <p className="rml-chips__question">{request.question}</p>
      </div>

      <div className="rml-chips__row" role="group" aria-label={request.question}>
        {options.map((option, i) => {
          const isChosen = chosen === option
          return (
            <motion.button
              key={`${option}-${i}`}
              type="button"
              className={cx('rml-chip', isChosen && 'is-chosen', locked && !isChosen && 'is-dimmed')}
              onClick={() => pick(option)}
              disabled={locked}
              initial={{ opacity: 0, y: 8, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.3, ease: EASE, delay: 0.05 + i * 0.045 }}
              whileTap={locked ? undefined : { scale: 0.965 }}
              aria-pressed={isChosen}
            >
              {isChosen ? (
                <motion.span
                  className="rml-chip__check"
                  initial={{ opacity: 0, scale: 0.5 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.24, ease: EASE }}
                >
                  <Icon name="check" size={12} />
                </motion.span>
              ) : null}
              <span className="rml-chip__label">{option}</span>
            </motion.button>
          )
        })}
      </div>
    </motion.div>
  )
}

export default InputChips
