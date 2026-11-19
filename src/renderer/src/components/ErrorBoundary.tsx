import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { tr } from '../i18n'

interface State {
  error: Error | null
  note: string
  copied: boolean
}

/** Если интерфейс упал, показываем понятный экран вместо белого окна: перезагрузка и «Сообщить о проблеме». */
export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, note: '', copied: false }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    void window.api.logRendererError(error.message, `${error.stack ?? ''}\n${info.componentStack ?? ''}`)
  }

  report = async (): Promise<void> => {
    const e = this.state.error
    const r = await window.api.reportProblem(`${this.state.note}\n\n${e?.message ?? ''}`.trim())
    this.setState({ copied: r.copied })
  }

  render(): ReactNode {
    const { error, copied } = this.state
    if (!error) return this.props.children
    return (
      <div className="crash">
        <h1>{tr('Что-то пошло не так')}</h1>
        <p className="muted">{tr('Окно остановилось из-за ошибки. Ваши файлы не затронуты. Можно перезагрузить окно или сообщить о проблеме.')}</p>
        <pre className="crash-text">{error.message}</pre>
        <textarea
          className="text-input"
          rows={3}
          placeholder={tr('Что вы делали перед этим? (необязательно)')}
          value={this.state.note}
          onChange={(e) => this.setState({ note: e.target.value })}
        />
        <div className="row">
          <button className="btn primary" onClick={() => window.location.reload()}>
            {tr('Перезагрузить окно')}
          </button>
          <button className="btn soft" onClick={() => void this.report()}>
            {tr('Сообщить о проблеме')}
          </button>
          <button className="btn ghost" onClick={() => void window.api.openLogsFolder()}>
            {tr('Открыть папку журнала')}
          </button>
        </div>
        {copied && <p className="notice">{tr('Отчёт слишком длинный для адреса: он скопирован в буфер обмена. Вставьте его в открывшуюся страницу.')}</p>}
      </div>
    )
  }
}
