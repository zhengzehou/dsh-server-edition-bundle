import { spawn } from 'node:child_process'

function executableFor(command, args) {
  if (process.platform !== 'win32' || command !== 'dsh') return { command, args }
  return {
    command: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', 'dsh.cmd', ...args],
  }
}

export function spawnFile(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const executable = executableFor(command, args)
    const child = spawn(executable.command, executable.args, { shell: false, ...options })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`))
    })
  })
}

export { executableFor }
