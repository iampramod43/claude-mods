export type Op = 'read' | 'edit' | 'write' | 'search'
export type Entry = { name: string; isDir: boolean }
export type Touch = { isDir: boolean; read: number; edit: number; write: number; search: number; last: number; lastAt: number }
export type Active = { path: string; op: Op }
export type Trail = {
  root: string
  rootEntries: Entry[]
  sizes: Record<string, number>
  touches: Record<string, Touch>
  active: Record<string, Active[]>
  outside: number
  seq: number
}

declare module 'claude-code' {
  interface PluginState {
    'file-trail': { trail: Trail; tick: number }
  }
}
