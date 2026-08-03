/* Markdown renderer for every piece of model prose in the app.
 * remark-gfm (tables/strikethrough/task lists) + remark-math + rehype-katex.
 * Code fences get a language label and a copy button; everything else is styled
 * against the design tokens so prose feels typeset rather than dumped. */

import { memo, useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { AnimatePresence, motion } from 'framer-motion'
import { EASE } from '../../lib/motion'
import { cx } from '../../lib/utils'
import { Icon } from './icons'
import 'katex/dist/katex.min.css'
import './Markdown.css'

import type { PluggableList } from 'unified'

const REMARK: PluggableList = [remarkGfm, remarkMath]
const REHYPE: PluggableList = [[rehypeKatex, { throwOnError: false, strict: false }]]

/* ------------------------------------------------------------------- copy */

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/** Small copy affordance — idle glyph morphs into a check for ~1.6s. */
export function CopyButton({
  value,
  className,
  label = 'Copy',
}: {
  value: string
  className?: string
  label?: string
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const onClick = useCallback(async () => {
    const ok = await writeClipboard(value)
    if (!ok) return
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1600)
  }, [value])

  return (
    <button
      type="button"
      className={cx('rml-copy', copied && 'is-copied', className)}
      onClick={onClick}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
    >
      <span className="rml-copy__glyph">
        <AnimatePresence initial={false} mode="wait">
          <motion.span
            key={copied ? 'ok' : 'idle'}
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.7 }}
            transition={{ duration: 0.2, ease: EASE }}
          >
            <Icon name={copied ? 'check' : 'copy'} size={13} />
          </motion.span>
        </AnimatePresence>
      </span>
      <span className="rml-copy__text">{copied ? 'Copied' : label}</span>
    </button>
  )
}

/* -------------------------------------------------------------- code block */

const LANG_LABEL: Record<string, string> = {
  js: 'JavaScript',
  jsx: 'JSX',
  ts: 'TypeScript',
  tsx: 'TSX',
  py: 'Python',
  sh: 'Shell',
  bash: 'Bash',
  zsh: 'Zsh',
  html: 'HTML',
  css: 'CSS',
  json: 'JSON',
  md: 'Markdown',
  sql: 'SQL',
  yml: 'YAML',
  yaml: 'YAML',
}

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const label = lang ? (LANG_LABEL[lang] ?? lang.toUpperCase()) : 'Text'
  return (
    <div className="rml-code">
      <div className="rml-code__bar">
        <span className="rml-code__lang">{label}</span>
        <CopyButton value={code} />
      </div>
      <pre className="rml-code__pre">
        <code className={lang ? `language-${lang}` : undefined}>{code}</code>
      </pre>
    </div>
  )
}

/* -------------------------------------------------------------- components */

const COMPONENTS: Components = {
  a({ node: _node, children, href, ...props }) {
    return (
      <a
        {...props}
        href={href}
        className="rml-md__link"
        target="_blank"
        rel="noopener noreferrer nofollow"
      >
        {children}
      </a>
    )
  },
  // Fences render their own shell, so the default <pre> wrapper is dropped.
  pre({ children }) {
    return <>{children}</>
  },
  code({ node: _node, className, children, ...props }) {
    const text = String(children ?? '')
    const match = /language-([\w+#-]+)/.exec(className ?? '')
    if (!match && !text.includes('\n')) {
      return (
        <code {...props} className="rml-md__code">
          {children}
        </code>
      )
    }
    return <CodeBlock code={text.replace(/\n$/, '')} lang={match?.[1]} />
  },
  table({ node: _node, children, ...props }) {
    return (
      <div className="rml-md__table-wrap">
        <table {...props}>{children}</table>
      </div>
    )
  },
  img({ node: _node, alt, ...props }) {
    return <img {...props} alt={alt ?? ''} className="rml-md__img" loading="lazy" />
  },
  input({ node: _node, ...props }) {
    // GFM task-list checkboxes: read-only, restyled.
    return <input {...props} className="rml-md__check" disabled readOnly />
  },
}

/* ------------------------------------------------------------------ public */

export interface MarkdownProps {
  /** Raw markdown source. Streams fine — re-parsed on every delta. */
  children: string
  className?: string
}

/** Styled markdown + math. Memoized: streaming re-renders hit this a lot. */
export const Markdown = memo(function Markdown({ children, className }: MarkdownProps) {
  return (
    <div className={cx('rml-md', className)}>
      <ReactMarkdown
        remarkPlugins={REMARK}
        rehypePlugins={REHYPE}
        components={COMPONENTS}
        skipHtml
      >
        {children}
      </ReactMarkdown>
    </div>
  )
})

export default Markdown
