interface Intent {
  type: string
  text?: string
}

export function chatIntent(intent: Intent): void {
  switch (intent.type) {
    case 'prompt':
      console.log(intent.text)
      break
    case 'cancel':
      console.log('stopped')
      break
  }
}
