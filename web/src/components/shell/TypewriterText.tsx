import { useEffect, useRef, useState } from 'react'
import { useReducedMotion } from 'framer-motion'
import { cx } from '../../lib/utils'
import './TypewriterText.css'

export interface TypewriterTextProps {
  text: string
  className?: string
}

/** Erases the previous value, pauses at the caret, then types the next value. */
export function TypewriterText({ text, className }: TypewriterTextProps) {
  const reduceMotion = !!useReducedMotion()
  const [visible, setVisible] = useState(text)
  const [writing, setWriting] = useState(false)
  const visibleRef = useRef(text)

  useEffect(() => {
    if (visibleRef.current === text) return
    if (reduceMotion) {
      visibleRef.current = text
      setVisible(text)
      setWriting(false)
      return
    }

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const target = Array.from(text)
    let targetIndex = 0

    const schedule = (callback: () => void, delay: number) => {
      timer = setTimeout(() => {
        if (!cancelled) callback()
      }, delay)
    }

    const typeNext = () => {
      if (targetIndex >= target.length) {
        setWriting(false)
        return
      }
      visibleRef.current += target[targetIndex]
      targetIndex += 1
      setVisible(visibleRef.current)
      schedule(typeNext, target[targetIndex - 1] === ' ' ? 18 : 28)
    }

    const eraseNext = () => {
      const current = Array.from(visibleRef.current)
      if (current.length === 0) {
        schedule(typeNext, 72)
        return
      }
      current.pop()
      visibleRef.current = current.join('')
      setVisible(visibleRef.current)
      schedule(eraseNext, 14)
    }

    setWriting(true)
    schedule(eraseNext, 70)

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [text, reduceMotion])

  return (
    <span className={cx('rml-typewriter', writing && 'is-writing', className)} aria-label={text}>
      <span aria-hidden="true">{visible}</span>
      {writing ? <span className="rml-typewriter__caret" aria-hidden="true" /> : null}
    </span>
  )
}

export default TypewriterText
