// Optional: creates one funded account per app with the faucet and writes their seeds to .env.
// Seeds already present in .env are kept, so you can stop it and run it again.
const fs = require('fs')
const path = require('path')
const dotenv = require('dotenv')
const { Client, dropsToXah } = require('xahau')
const { walletFromSeed } = require('./lib/config')

const ENV_PATH = path.join(__dirname, '.env')
const ACCOUNTS = ['LINKS_SEED', 'GAME_SEED', 'LEDGER_SEED']
const COOLDOWN_SECONDS = 60 // the faucet only gives one account per minute

const sleep = seconds => new Promise(resolve => setTimeout(resolve, seconds * 1000))

// Asks the faucet for a new funded account, retrying after the cooldown if it refuses
async function requestAccount(faucetUrl) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    let wait = COOLDOWN_SECONDS
    try {
      const res = await fetch(faucetUrl, { method: 'POST' })
      const body = await res.json()
      if (res.ok && body.secret && body.code === 'tesSUCCESS') return body
      console.log(`  Faucet said: ${body.error || JSON.stringify(body)}`)
      const seconds = /wait (\d+) seconds/.exec(body.error || '')
      if (seconds) wait = Number(seconds[1]) + 2
    } catch (error) {
      console.log(`  Faucet unavailable: ${error.message}`)
    }
    console.log(`  Retrying in ${wait}s...`)
    await sleep(wait)
  }
  throw new Error('The faucet did not give an account after 5 attempts')
}

// Writes KEY=value into .env, keeping the comment of the line if there is one
function saveSeed(key, seed) {
  let env = fs.readFileSync(ENV_PATH, 'utf8')
  const line = new RegExp(`^${key}=.*$`, 'm')
  env = line.test(env)
    ? env.replace(line, old => `${key}=${seed}${old.match(/\s(#.*)$/) ? `  ${old.match(/\s(#.*)$/)[1]}` : ''}`)
    : `${env.trimEnd()}\n${key}=${seed}\n`
  fs.writeFileSync(ENV_PATH, env)
}

async function createAccounts() {
  if (!fs.existsSync(ENV_PATH)) {
    fs.copyFileSync(path.join(__dirname, '.env.example'), ENV_PATH)
    console.log('Created .env from .env.example')
  }

  let env = dotenv.parse(fs.readFileSync(ENV_PATH))
  const faucetUrl = env.FAUCET_URL || 'https://xahau-test.net/newcreds'
  const missing = ACCOUNTS.filter(key => !env[key])

  if (missing.length > 1) {
    console.log(`Creating ${missing.length} accounts. It takes about ${(missing.length - 1) * COOLDOWN_SECONDS}s because of the faucet cooldown.\n`)
  }

  for (const [i, key] of missing.entries()) {
    if (i > 0) {
      console.log(`  Waiting ${COOLDOWN_SECONDS}s for the faucet cooldown...`)
      await sleep(COOLDOWN_SECONDS)
    }
    const account = await requestAccount(faucetUrl)

    // Check that the seed really opens that address
    const wallet = walletFromSeed(account.secret)
    if (wallet.address !== account.address) throw new Error(`Seed does not match ${account.address}`)

    saveSeed(key, account.secret)
    console.log(`${key.padEnd(12)} ${account.address}  (+${account.xrp} XAH)`)
  }

  // Show what every account in .env holds now
  env = dotenv.parse(fs.readFileSync(ENV_PATH))
  const client = new Client(env.WSS_URL || 'wss://xahau-test.net')
  await client.connect()
  console.log('\nBalances:')
  for (const key of ACCOUNTS) {
    const { address } = walletFromSeed(env[key])
    let balance = 'not funded yet (try again in a few seconds)'
    // The last faucet payment may still be waiting for its ledger to close
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const { result } = await client.request({ command: 'account_info', account: address, ledger_index: 'validated' })
        balance = `${dropsToXah(result.account_data.Balance)} XAH`
        break
      } catch {
        await sleep(2)
      }
    }
    console.log(`${key.padEnd(12)} ${address}  ${balance}`)
  }
  await client.disconnect()
}

createAccounts().catch(console.error)
