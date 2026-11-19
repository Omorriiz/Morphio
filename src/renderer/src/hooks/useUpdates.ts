import { useEffect, useState } from 'react'
import type { UpdateState } from '@shared/types'

/** Состояние автообновления: приходит из основного процесса, меняется по ходу проверки и скачивания. */
export function useUpdates(): UpdateState {
  const [state, setState] = useState<UpdateState>({ status: 'idle' })
  useEffect(() => {
    void window.api.updatesState().then(setState)
    return window.api.onUpdateState(setState)
  }, [])
  return state
}
