/* components/document — the asset-takeover surface.
 *
 * DocumentView is the single mount point (App.tsx puts it in the main column whenever the
 * open chat has at least one asset); DocumentDock replaces the docked composer while it is up. */

export { default as DocumentView, type DocumentViewProps } from './DocumentView'
export { default as DocumentFrame, type DocumentFrameProps } from './DocumentFrame'
export { default as DocumentHeader, type DocumentHeaderProps } from './DocumentHeader'
export { default as DocumentDock, type DocumentDockProps } from './DocumentDock'
export { default as HistoryOverlay, type HistoryOverlayProps } from './HistoryOverlay'

export { default } from './DocumentView'
