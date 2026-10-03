import type { DisplayPair, FloatingPlacement } from './geometry.ts'

interface DisplayScreen {
  getAllDisplays(): readonly DisplayPair[]
  on(event: 'display-added' | 'display-removed', listener: () => void): void
  on(event: 'display-metrics-changed', listener: (event: unknown, display: DisplayPair, metrics: string[]) => void): void
  removeListener(event: 'display-added' | 'display-removed', listener: () => void): void
  removeListener(event: 'display-metrics-changed', listener: (event: unknown, display: DisplayPair, metrics: string[]) => void): void
}

/** Listen only while the ball exists. Recovery changes bounds, never window visibility. */
export function attachDisplayRecovery(
  screen: DisplayScreen,
  window: { isDestroyed(): boolean },
  placement: FloatingPlacement,
): () => void {
  const recover = (): void => {
    if (!window.isDestroyed()) placement.recoverDisplays(screen.getAllDisplays())
  }
  const metricsChanged = (_event: unknown, _display: DisplayPair, metrics: string[]): void => {
    if (metrics.some((metric) => ['bounds', 'workArea', 'scaleFactor', 'rotation'].includes(metric))) recover()
  }
  screen.on('display-added', recover)
  screen.on('display-removed', recover)
  screen.on('display-metrics-changed', metricsChanged)
  return () => {
    screen.removeListener('display-added', recover)
    screen.removeListener('display-removed', recover)
    screen.removeListener('display-metrics-changed', metricsChanged)
  }
}
