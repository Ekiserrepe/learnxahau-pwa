// Is PWALoader enabled on this network, and what does publishing cost here?
const { Client } = require('xahau')
const { WSS_URL, PWA_ZONE } = require('./lib/config')
const { MAX_APP_LOADER_BYTES, FEE_DROPS_PER_BYTE } = require('./lib/apploader')

async function checkPwa() {
  const client = new Client(WSS_URL)
  await client.connect()

  const { result: server } = await client.request({ command: 'server_info' })
  console.log(`Node:       ${WSS_URL}`)
  console.log(`Build:      ${server.info.build_version}`)
  console.log(`Network ID: ${server.info.network_id}`)

  const { result: features } = await client.request({ command: 'feature', feature: 'PWALoader' })
  const [amendment] = Object.values(features)
  console.log(`PWALoader:  ${amendment?.enabled ? 'enabled' : 'NOT enabled'}`)

  const { result: fee } = await client.request({ command: 'fee' })
  const base = Number(fee.drops.base_fee)
  console.log(`\nBase fee:   ${base} drops`)
  console.log(`Document:   up to ${MAX_APP_LOADER_BYTES} bytes, +${FEE_DROPS_PER_BYTE} drop per byte`)
  console.log(`Max fee:    ${base + MAX_APP_LOADER_BYTES * FEE_DROPS_PER_BYTE} drops (${(base + MAX_APP_LOADER_BYTES) / 1e6} XAH) for a full 4 KB page`)

  await client.disconnect()

  // Serving is a node feature, not a protocol rule: check the zone answers like a pwa port.
  // The bare zone never serves a page, it redirects or 404s, so any short reply is fine here
  try {
    const res = await fetch(`https://${PWA_ZONE}/`, { redirect: 'manual' })
    console.log(`\nPWA zone:   https://${PWA_ZONE} answered ${res.status} (${res.headers.get('referrer-policy') === 'no-referrer' ? 'looks like a pwa port' : 'unknown server'})`)
  } catch (error) {
    console.log(`\nPWA zone:   https://${PWA_ZONE} unreachable (${error.message})`)
  }
}

checkPwa().catch(console.error)
