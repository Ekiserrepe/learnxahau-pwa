// Downloads a page the way a browser does and checks it against the ledger with pwa_validate.
//   node 05-verify.js <links|game|ledger|r-address>
require('dotenv').config()
const { Client } = require('xahau')
const { addressFor, WSS_URL, PWA_ZONE } = require('./lib/config')
const { sha512Half, pwaUrl } = require('./lib/apploader')

async function verify() {
  if (!process.argv[2]) throw new Error('Usage: node 05-verify.js <app|r-address>')
  const address = addressFor(process.argv[2])

  // A second node, ideally run by someone else than the one that served the page
  const client = new Client(process.env.VERIFY_WSS_URL || WSS_URL)
  await client.connect()
  const { result: info } = await client.request({ command: 'account_info', account: address, ledger_index: 'validated' })
  const url = pwaUrl(PWA_ZONE, info.account_data.AccountIndex, address)

  // 1. Fetch the page and show what the pwa port says about it
  const res = await fetch(url, { cache: 'no-store' })
  const body = Buffer.from(await res.arrayBuffer())
  console.log(`GET ${url}\n${res.status} ${res.statusText}`)
  for (const h of ['content-type', 'content-security-policy', 'x-frame-options', 'cache-control', 'etag', 'x-networkid', 'x-ledgerseq', 'x-ledgerhash', 'x-pwaseq']) {
    console.log(`  ${h}: ${res.headers.get(h)}`)
  }

  // 2. Ask the second node whether those bytes are the account's current document
  const hash = sha512Half(body)
  const { result } = await client.request({ command: 'pwa_validate', account: address, hash })
  console.log(`\npwa_validate (${body.length} bytes, SHA-512Half ${hash.slice(0, 16)}...)`)
  console.log(JSON.stringify(result, null, 2))
  if (!result.valid && result.reason === 'hash mismatch' && Number(res.headers.get('x-ledgerseq')) < result.ledger_index) {
    console.log('The page came from an older ledger than the check: reload and try again')
  }

  // 3. The ETag is the PreviousTxnID of the AppLoader object: revalidation costs no body.
  // Some proxies (Cloudflare, for one) drop the header, but the node still honours the tag
  const { result: entry } = await client.request({ command: 'ledger_entry', app_loader: address, ledger_index: 'validated' })
  const etag = res.headers.get('etag') || `"${entry.node.PreviousTxnID}"`
  const again = await fetch(url, { headers: { 'If-None-Match': etag } })
  console.log(`\nIf-None-Match: ${etag}\n→ ${again.status} ${again.statusText}`)

  await client.disconnect()
}

verify().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
