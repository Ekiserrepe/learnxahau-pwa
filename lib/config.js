// Shared settings: which account publishes which app, and how to reach the network.
require('dotenv').config()
const { Wallet } = require('xahau')

const APPS = {
  links: 'LINKS_SEED',
  game: 'GAME_SEED',
  ledger: 'LEDGER_SEED'
}

const WSS_URL = process.env.WSS_URL || 'wss://xahau-test.net'
const PWA_ZONE = process.env.PWA_ZONE || 'pwa.exposed'
const EXPLORER_URL = process.env.EXPLORER_URL || 'https://explorer.xahau-test.net'

function appName(arg) {
  if (!APPS[arg]) throw new Error(`Usage: node <script> <${Object.keys(APPS).join('|')}>`)
  return arg
}

// Ed25519 seeds start with "sEd"; the Testnet faucet hands out secp256k1 ones
const walletFromSeed = seed => Wallet.fromSeed(seed, { algorithm: seed.startsWith('sEd') ? 'ed25519' : 'secp256k1' })

function walletFor(app) {
  const seed = process.env[APPS[app]]
  if (!seed) throw new Error(`${APPS[app]} is empty in .env (run node 00-create-accounts.js)`)
  return walletFromSeed(seed)
}

// Accepts an app name (uses its account) or any r-address
const addressFor = arg => (APPS[arg] ? walletFor(arg).address : arg)

module.exports = { APPS, WSS_URL, PWA_ZONE, EXPLORER_URL, appName, walletFromSeed, walletFor, addressFor }
