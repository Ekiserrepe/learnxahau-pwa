// Reads the AppLoader of any account straight from the ledger and saves it as an HTML file.
//   node 04-read.js <links|game|ledger|r-address>
const fs = require('fs')
const path = require('path')
const { Client } = require('xahau')
const { addressFor, WSS_URL, PWA_ZONE } = require('./lib/config')
const { validate, sha512Half, pwaUrl, hexToBuffer } = require('./lib/apploader')

async function read() {
  if (!process.argv[2]) throw new Error('Usage: node 04-read.js <app|r-address>')
  const address = addressFor(process.argv[2])
  const client = new Client(WSS_URL)
  await client.connect()

  let node
  try {
    ;({ result: { node } } = await client.request({ command: 'ledger_entry', app_loader: address, ledger_index: 'validated' }))
  } catch (error) {
    await client.disconnect()
    throw new Error(`${address} has no AppLoader (${error.data?.error || error.message})`)
  }
  const { result: info } = await client.request({ command: 'account_info', account: address, ledger_index: 'validated' })
  await client.disconnect()

  const doc = hexToBuffer(node.AppLoader)
  console.log(JSON.stringify({ ...node, AppLoader: `<${doc.length} bytes>` }, null, 2))
  console.log(`\nValidator:   ${validate(doc)}`)
  console.log(`SHA-512Half: ${sha512Half(doc)}`)
  console.log(`URL:         ${pwaUrl(PWA_ZONE, info.account_data.AccountIndex, address)}`)

  fs.mkdirSync(path.join(__dirname, 'build'), { recursive: true })
  const out = path.join(__dirname, 'build', `read-${address}.html`)
  fs.writeFileSync(out, doc)
  console.log(`Saved:       ${path.relative(__dirname, out)}`)
}

read().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
