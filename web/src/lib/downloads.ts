/** Build a Finder-safe filename while preserving readable Unicode titles. */
export function htmlDownloadFilename(title: string | undefined, version: number): string {
  const base = (title || 'rautml-document')
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 120)
    .replace(/[\s.]+$/g, '')

  return `${base || 'rautml-document'}-v${Math.max(1, version)}.html`
}

/** Hand a generated HTML file to the browser's native download flow. */
export function downloadHtmlFile(html: string, filename: string): void {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.hidden = true
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}
