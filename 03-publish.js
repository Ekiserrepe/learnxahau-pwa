// Publishes build/<app>.html as the AppLoader of the app's account, then waits for a node to serve it.
//   node 03-publish.js <links|game|ledger>
const fs = require('fs')
const path = require('path')
const { Client } = require('xahau')
const { appName, walletFor, WSS_URL, PWA_ZONE, EXPLORER_URL } = require('./lib/config')
const { validate, pwaUrl, hexToBuffer } = require('./lib/apploader')

const sleep = seconds => new Promise(resolve => setTimeout(resolve, seconds * 1000))

async function publish() {
  const app = appName(process.argv[2])
  const file = path.join(__dirname, 'build', `${app}.html`)
  if (!fs.existsSync(file)) throw new Error(`Run node 02-build.js ${app} first`)
  const doc = fs.readFileSync(file)

  // Same checks consensus runs in preflight: a bad document is temMALFORMED
  const verdict = validate(doc)
  if (verdict !== 'ok') throw new Error(`Invalid document: ${verdict}`)

  const client = new Client(WSS_URL)
  await client.connect()
  const wallet = walletFor(app)
  console.log(`Account:  ${wallet.address}`)
  console.log(`Document: ${doc.length} bytes`)

  // autofill asks the node for the fee of this exact blob: base fee + 1 drop per byte
  const tx = await client.autofill({
    TransactionType: 'AccountSet',
    Account: wallet.address,
    AppLoader: doc.toString('hex').toUpperCase()
  })
  console.log(`Fee:      ${tx.Fee} drops`)

  const { result } = await client.submitAndWait(wallet.sign(tx).tx_blob)
  console.log(`AccountSet: ${result.meta.TransactionResult}`)
  console.log(`Explorer:   ${EXPLORER_URL}/tx/${result.hash}`)
  if (result.meta.TransactionResult !== 'tesSUCCESS') return client.disconnect()

  // The ledger now holds an AppLoader object keyed on the owner alone
  const { result: entry } = await client.request({ command: 'ledger_entry', app_loader: wallet.address, ledger_index: 'validated' })
  if (!hexToBuffer(entry.node.AppLoader).equals(doc)) throw new Error('The ledger holds different bytes')
  console.log(`AppLoaderSequence: ${entry.node.AppLoaderSequence}`)

  // The host label is the account's AccountIndex, in decimal
  const { result: info } = await client.request({ command: 'account_info', account: wallet.address, ledger_index: 'validated' })
  await client.disconnect()
  const url = pwaUrl(PWA_ZONE, info.account_data.AccountIndex, wallet.address)

  // Nodes only serve validated state: give the pwa port a moment to catch up
  for (let attempt = 0; attempt < 10; attempt++) {
    const res = await fetch(url, { cache: 'no-store' })
    const body = Buffer.from(await res.arrayBuffer())
    if (res.status === 200 && body.equals(doc)) {
      console.log(`\nLive at:  ${url}`)
      return
    }
    console.log(`  ${res.status}, retrying...`)
    await sleep(2)
  }
  console.log(`\nPublished, but ${url} is not serving it yet`)
}

publish().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
