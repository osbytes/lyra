import { Component, type ErrorInfo, type ReactNode } from 'react'
import { log } from '../lib/log'

type Props = {
  /** Where this boundary sits, for the log. */
  scope: string
  /** Changing it clears a caught error, e.g. the open session's id. */
  resetKey?: string | null
  /** `window` fills the window; `pane` fits inside a pane and leaves the rest of the app up. */
  variant?: 'window' | 'pane'
  children: ReactNode
}

type State = { failed: boolean; resetKey: string | null | undefined }

/**
 * Catches a rendering error below it and shows a plain message with a way out, instead of a
 * blank window. React only offers this as a class component. Logs the error's name and message,
 * never props or content: a message can't hold note text unless code put it there.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false, resetKey: this.props.resetKey }

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey === state.resetKey) return null
    return { failed: false, resetKey: props.resetKey }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    log('ui', 'render error', {
      scope: this.props.scope,
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
      component: info.componentStack?.split('\n').find((line) => line.trim())?.trim() ?? null
    })
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children
    const pane = this.props.variant === 'pane'
    return (
      <div className={pane ? 'error-boundary is-pane' : 'error-boundary'} role="alert">
        <h2>Something went wrong</h2>
        <p>
          {pane
            ? 'This session couldn’t be shown. Your notes are saved, and a recording keeps going. Open another session, or try again.'
            : 'Lyra hit a problem drawing this window. Your notes are saved.'}
        </p>
        {pane ? (
          // Reloading would cut a recording off mid-take, so the pane only tries drawing again.
          <button
            className="btn primary"
            type="button"
            onClick={() => {
              this.setState({ failed: false })
            }}
          >
            Try again
          </button>
        ) : (
          <button
            className="btn primary"
            type="button"
            onClick={() => {
              window.location.reload()
            }}
          >
            Reload window
          </button>
        )}
      </div>
    )
  }
}
