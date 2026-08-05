/**
 * remark-math understands dollar delimiters, while models also commonly emit
 * LaTeX's \(...\) and \[...\] forms. Normalize those before Markdown consumes
 * the backslashes, leaving fenced and inline code examples untouched.
 */
export function normalizeMathDelimiters(source: string): string {
  const code = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g
  return source
    .split(code)
    .map((part, index) => {
      if (index % 2 === 1) return part
      return part
        .replace(/\\\[/g, () => '\n$$\n')
        .replace(/\\\]/g, () => '\n$$\n')
        .replace(/\\\(/g, () => '$')
        .replace(/\\\)/g, () => '$')
    })
    .join('')
}

/**
 * CommonMark cannot open emphasis immediately before punctuation. Models often
 * wrap Korean quoted phrases as **“문구”**, so move paired quotes outside the
 * emphasis markers before parsing. Apply only to complete, single-line pairs.
 */
export function normalizeQuotedEmphasis(source: string): string {
  const code = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g
  return source
    .split(code)
    .map((part, index) => {
      if (index % 2 === 1) return part
      return part
        .replace(/\*\*“([^”\n]+)”\*\*/g, '“**$1**”')
        .replace(/\*\*‘([^’\n]+)’\*\*/g, '‘**$1**’')
        .replace(/__“([^”\n]+)”__/g, '“__$1__”')
        .replace(/__‘([^’\n]+)’__/g, '‘__$1__’')
    })
    .join('')
}

export function normalizeForkMarkdown(source: string): string {
  return normalizeQuotedEmphasis(normalizeMathDelimiters(source))
}
