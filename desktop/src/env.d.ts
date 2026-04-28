declare global {
  interface Window {
    butter: {
      invoke<T = unknown>(action: string, data?: unknown, opts?: { timeout?: number }): Promise<T>
      on(action: string, handler: (data: any) => void): void
      off(action: string, handler: (data: any) => void): void
      tray: {
        set(opts: { title?: string; tooltip?: string; items?: Array<{ label: string; action: string } | { separator: true }> }): Promise<unknown>
        remove(): Promise<unknown>
      }
      shortcuts: {
        register(shortcut: { key: string; modifiers?: Array<"cmd" | "ctrl" | "alt" | "shift"> }, id: string): Promise<unknown>
        unregister(id: string): Promise<unknown>
      }
      clipboard: {
        read(): Promise<{ ok: boolean; value?: string; error?: string }>
        write(value: string): Promise<unknown>
      }
      notify: {
        send(opts: { title: string; body?: string; icon?: string }): Promise<unknown>
      }
      shell: {
        openurl(url: string): Promise<unknown>
        openpath(path: string): Promise<unknown>
      }
    }
  }
}

export {}
