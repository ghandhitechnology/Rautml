/* ForkMarkdown — the fork panel's own markdown renderer.
 *
 * Deliberately self-contained (no imports from components/chat): react-markdown +
 * remark-gfm + remark-math + rehype-katex, tuned for a 380px column. Code blocks get
 * a copy button; links open in a new tab; tables scroll inside their own container.
 */

import { memo, useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components, type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { normalizeForkMarkdown } from '../../lib/markdownMath'
import { cx } from '../../lib/utils'
import 'katex/dist/katex.min.css'
import './ForkMarkdown.css'

function ForkCodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  const copy = useCallback(() => {
    const text = ref.current?.innerText ?? ''
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
    if (!text || !clipboard) return
    clipboard
      .writeText(text)
      .then(() => {
        setCopied(true)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setCopied(false), 1400)
      })
      .catch(() => {
        /* clipboard denied — the code is still selectable */
      })
  }, [])

  return (
    <div className="rml-forkmd__block">
      <pre ref={ref}>{children}</pre>
      <button
        type="button"
        className={cx('rml-forkmd__copy', copied && 'is-copied')}
        onClick={copy}
        aria-label={copied ? 'Copied' : 'Copy code'}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

const COMPONENTS: Components = {
  pre: ({ children }) => <ForkCodeBlock>{children}</ForkCodeBlock>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="rml-forkmd__tablewrap">
      <table>{children}</table>
    </div>
  ),
}

const REMARK: NonNullable<Options['remarkPlugins']> = [remarkGfm, remarkMath]
// Half-written $…$ is normal while streaming — never throw, just render it plainly.
const REHYPE: NonNullable<Options['rehypePlugins']> = [
  [rehypeKatex, { throwOnError: false, strict: false, errorColor: 'currentColor' }],
]

export interface ForkMarkdownProps {
  children: string
  className?: string
}

export const ForkMarkdown = memo(function ForkMarkdown({ children, className }: ForkMarkdownProps) {
  const markdown = useMemo(() => normalizeForkMarkdown(children), [children])

  return (
    <div className={cx('rml-forkmd', className)}>
      <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={COMPONENTS}>
        {markdown}
      </ReactMarkdown>
    </div>
  )
})

export default ForkMarkdown
