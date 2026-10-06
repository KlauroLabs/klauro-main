import type { Frame } from '../packages/remote/client'
import { chatIntent } from './intents'

export function onFrame(frame: Frame): void {
  switch (frame.t) {
    case 'data':
      chatIntent(JSON.parse(frame.b ?? '{}'))
      break
    case 'devices':
      break
  }
}
