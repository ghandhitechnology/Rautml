/// <reference types="vite/client" />

interface RautmlDesktopApi {
  renderPdf(html: string): Promise<ArrayBuffer>
}

interface Window {
  rautmlDesktop?: RautmlDesktopApi
}
