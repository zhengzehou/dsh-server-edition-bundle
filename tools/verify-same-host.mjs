console.log('DSH same-host verification: start')
await import('../tests/control-plane-smoke.mjs')
await import('../tests/same-host-smoke.mjs')
console.log('DSH same-host verification: PASS')
