import { execFileSync } from 'child_process'
import * as path from 'path'

function binaryPath(): string {
  return path.join(__dirname, '..', 'native', 'engine-core')
}

export function parse(lang: string, source: string): string {
  const binary = binaryPath()
  return execFileSync(binary, [lang], { input: source, encoding: 'utf8', maxBuffer: 1024 })
}

export function listDirectory(): string {
  return execFileSync('ls', ['-la'], { encoding: 'utf8' })
}
