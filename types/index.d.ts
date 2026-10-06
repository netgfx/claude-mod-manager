declare module 'claude-code' {
  interface PluginState {
    'mod-manager': {
      // Every installed plugin, with what the last check found
      mods: ModInfo[]
      // The background check: what it is doing, when it last finished, and why it failed
      scan: ScanInfo
      // The message line at the top of the pane
      notice: Notice | null
      // The action that is running right now
      busy: Busy | null
      // An install, update or uninstall happened and plugins haven't been reloaded yet
      pendingReload: boolean
    }
  }
}

export type ModStatus = 'checking' | 'current' | 'outdated' | 'unknown' | 'dev' | 'gone'

export type ModInfo = {
  uid: string
  id: string
  name: string
  marketplace: string
  version: string
  scope: string
  enabled: boolean
  isDev: boolean
  installPath: string
  lastUpdated: string
  sha: string
  status: ModStatus
  latest: string
  latestSha: string
  reason: string
  description: string
  homepage: string
  // Auto-update is on for this mod (its own choice, or the auto_update setting)
  auto: boolean
}

export type ScanInfo = { phase: 'idle' | 'listing' | 'fetching'; at: number; error: string }
export type Notice = { text: string; kind: 'ok' | 'error' | 'info'; at: number }
export type Busy = { uid: string; verb: string; label?: string }
