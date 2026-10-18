// Removes the app's AppLoader: an AccountSet with an empty AppLoader field.
//   node 06-remove.js <links|game|ledger>
const { Client } = require('xahau')
const { appName, walletFor, WSS_URL } = require('./lib/config')

async function remove() {
  const app = appName(process.argv[2])
  const client = new Client(WSS_URL)
  await client.connect()
  const wallet = walletFor(app)

  // An empty blob is the removal sentinel; it is not validated and pays no per-byte fee
  const tx = await client.autofill({
    TransactionType: 'AccountSet',
    Account: wallet.address,
    AppLoader: ''
  })
  const { result } = await client.submitAndWait(wallet.sign(tx).tx_blob)
  console.log(`AccountSet: ${result.meta.TransactionResult} (fee ${tx.Fee} drops)`)

  // AppLoaderSequence still goes up, so readers can tell the page was removed on purpose
  const { result: info } = await client.request({ command: 'account_info', account: wallet.address, ledger_index: 'validated' })
  console.log(`AppLoaderSequence: ${info.account_data.AppLoaderSequence}`)

  await client.disconnect()
}

remove().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
