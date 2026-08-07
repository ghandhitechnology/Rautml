/** Build a Finder-safe filename stem while preserving readable Unicode titles. */
function downloadFilenameStem(title: string | undefined, version: number) {
  const base = (title || 'rautml-document')
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 120)
    .replace(/[\s.]+$/g, '')

  return `${base || 'rautml-document'}-v${Math.max(1, version)}`
}

export function htmlDownloadFilename(title: string | undefined, version: number) {
  return `${downloadFilenameStem(title, version)}.html`
}

export function pdfDownloadFilename(title: string | undefined, version: number) {
  return `${downloadFilenameStem(title, version)}.pdf`
}

function downloadBlob(blob: Blob, filename: string) {
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

/** Hand a generated HTML file to the browser's native download flow. */
export function downloadHtmlFile(html: string, filename: string) {
  downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), filename)
}

/** Hand an Electron-rendered PDF to the browser's native download flow. */
export function downloadPdfFile(pdf: ArrayBuffer, filename: string) {
  downloadBlob(new Blob([pdf], { type: 'application/pdf' }), filename)
}
