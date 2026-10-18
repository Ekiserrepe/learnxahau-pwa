Welcome to Learning Xahau, a series of articles dedicated to helping developers, builders, and blockchain enthusiasts better understand the Xahau ecosystem. Whether you're just getting started or already building advanced applications, these posts will explore Xahau's features, architecture, and best practices through practical examples and real-world use cases.

Every dApp has the same weak spot: **the front-end**. The Hooks may run on a decentralised ledger, but users reach them through a website on a server, a domain and a DNS provider. If any of those disappears, gets hijacked or is taken down, users can't reach the app even though the ledger is still running.

The **PWALoader** amendment, shipped with the 2026.10 xahaud releases, takes a direct approach: it lets **an account store a web page on the ledger**, and lets nodes serve that page over HTTPS. In this article we'll look at how it works in the xahaud source code, and then build three apps with it:

1. **A links page** (Linktree style): a plain HTML document stored as is.
2. **A game** (Flappy Hook): a page too big for the ledger, compressed into a document that unpacks itself.
3. **A live dashboard**: a page that connects to the same ledger it is stored on.

All the code targets the **Xahau Testnet** (network `21338`, `wss://xahau-test.net`). PWALoader is enabled there, and Testnet now has a public **PWA portal at [pwa.exposed](https://pwa.exposed/)**, [announced by Richard Holland](https://x.com/RichardXRPL/status/2111635759598104838), so every page you publish gets a real URL. You also need **[xahau.js 4.2.0](https://www.npmjs.com/package/xahau)** or later, the first release with the `AppLoader` field and the `pwa_validate` request. The full repository is at [github.com/Ekiserrepe/learnxahau-pwa](https://github.com/Ekiserrepe/learnxahau-pwa).

---

## What PWALoader Adds

The amendment touches three layers: a transaction field, a ledger object and an HTTP server mode inside xahaud. It's easier to understand by following one page from submission to the browser.

### 1. A new field on `AccountSet`: `AppLoader`

There is no new transaction type. You publish a page with a normal [`AccountSet`](https://xahau.network/docs/protocol-reference/transactions/transaction-types/accountset/) that carries an `AppLoader` field (a variable-length blob) with the HTML document in hex:

```json
{
  "TransactionType": "AccountSet",
  "Account": "rG1SciZDoTzKpzLr7PnktCW8CyrQzZuQX8",
  "AppLoader": "3C21646F63747970652068746D6C3E0A3C68746D6C..."
}
```

An **empty** `AppLoader` (`""`) removes the page, following the same convention as `Domain` and `MessageKey`.

### 2. A shallow HTML check in consensus

Every validator has to check the page before accepting it, and parsing real HTML would be slow and risky for consensus. So instead of understanding the page, the ledger only checks that it *looks like* a complete HTML document. A document is accepted only if:

- it is **not empty** and is at most **4096 bytes**;
- it is **well-formed UTF-8** (the same strict decoder URIToken uses, which also rejects U+FFFE/U+FFFF);
- it has **no control characters** except TAB, LF, FF and CR, and no DEL;
- after an optional BOM and whitespace, it **starts** with `<!doctype` (followed by whitespace) or with an `<html` tag;
- it contains an `<html` start tag followed later by a **`</html>`** end tag;
- only whitespace comes **after the last `</html>`**.

A document that fails any rule is rejected with `temMALFORMED`. If the amendment isn't enabled, the field returns `temDISABLED`. Think of it as a basic sanity check, not a review: nobody looks at what the page says or does, so **content is not policed**.

### 3. A new ledger object: `AppLoader`

When the transaction succeeds, the ledger creates (or overwrites) a new [`AppLoader`](https://xahau.network/docs/protocol-reference/ledger-data/ledger-objects-types/app-loader/) ledger entry (type `0x004c`):

| Field | Meaning |
|---|---|
| `Owner` | The account that published the page |
| `AppLoader` | The document bytes |
| `AppLoaderSequence` | Version counter, copied from the owner's `AccountRoot` |
| `PreviousTxnID` / `PreviousTxnLgrSeq` | The last transaction that wrote it (also used as the HTTP ETag) |

Its ID is `SHA-512Half(0x0057 'W' + AccountID)`. Because the key depends **only on the owner**, each account has **at most one** page. To publish three apps you need three accounts, which is why this repo has one seed per app.

Every `AccountSet` that carries the field, **removals included**, increments `AppLoaderSequence` on the `AccountRoot`. A reader can therefore tell whether a copy is current, and whether a page was removed on purpose.

### 4. Paid per byte, with no reserve

This is the most interesting design choice. The object is **not linked into the owner directory and takes no owner reserve**. Instead, you pay for storage through the transaction fee:

```
fee = base fee + 1 drop × document bytes
```

A full 4 KB page costs about **0.0041 XAH** at a 10-drop base fee. The extra fee is charged on every write, including overwrites. Removal carries an empty blob, so it costs nothing extra. An account sitting at its reserve floor can still publish a page. If you underpay, the transaction fails with `telINSUF_FEE_P`. When you `autofill` with xahau.js, the library sends the signed blob to the node's `fee` method, so the per-byte part is calculated for you.

### 5. Serving: the `pwa` port

Storing HTML on a ledger isn't useful unless a browser can reach it. That part is **not consensus**: it's an opt-in server mode in xahaud. Serving isn't gated by the amendment either, so it's purely local configuration. A node operator adds a port with `protocol = pwa` (see `cfg/xahaud-example.cfg` and the [Serving PWA apps](https://xahau.network/docs/infrastructure/serving-pwa-apps/) guide):

```ini
[port_pwa]
port = 8088
ip = 127.0.0.1
protocol = pwa
secure_gateway = 127.0.0.1
domain = pwapp.example
```

The node then answers on:

```
https://pwa<AccountIndex>.<domain>/<r-address>    the page
https://<domain>/<r-address>                      301 redirect to the line above
```

A few details matter for app developers:

- **One host per account.** The label is `pwa` followed by the account's `AccountIndex` **in decimal** (JSON shows it in hex, so `"AccountIndex": "7ff9"` becomes `pwa32761`). Every app gets its **own browser origin**, so two apps can never read each other's data. The bare zone never serves a page.
- **Only validated state is served.** A page you just published appears once its ledger is validated, not before.
- **GET and HEAD only, rate-limited per IP**, behind a reverse proxy that terminates TLS. The node refuses direct connections.
- **Custom domains.** With `custom_domains = 1`, `app.example.org` can point at a node (CNAME) plus a TXT record `_xahau-pwa.app.example.org` holding the r-address. The account must consent by setting its `Domain` field to that host or a parent of it.
- **Operators keep control.** `[pwa_allowlist]` and `[pwa_blocklist]` decide which accounts *their* node serves. The protocol can't take a page down, but no operator has to host it. The config comment puts it plainly: *"Hosting, and a hosting provider's obligations, are yours."*

### 6. The sandbox: what your page can and cannot do

This section shapes how you write apps. Every page is served with these headers:

```
Content-Type: text/html; charset=utf-8
Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups
X-Frame-Options: DENY
Cross-Origin-Resource-Policy: same-origin
Cross-Origin-Opener-Policy: same-origin
Cache-Control: no-cache
ETag: "<PreviousTxnID>"
X-NetworkID / X-LedgerSeq / X-LedgerHash / X-PWASeq
```

The `sandbox` directive **without** `allow-same-origin` gives the page an **opaque origin** (`"null"`). I opened one of the pages from this article in Chrome and tested it:

| Feature | Result |
|---|---|
| JavaScript, forms, canvas, `WebSocket`, `crypto.subtle` | ✅ works (it's still a secure context) |
| `fetch()` to other sites that send CORS `*` (CDNs, Xahau nodes) | ✅ works |
| `localStorage`, `sessionStorage`, cookies | ❌ `SecurityError` |
| Service worker registration | ❌ `SecurityError` |
| `fetch()` of its own URL | ❌ blocked (no CORS on the pwa port) |
| Clipboard write after a click | ✅ worked in Chrome (keep a fallback) |
| Popups (`target="_blank"`) | ⚠️ open, but **inherit the sandbox** |
| Being framed in an `<iframe>` | ❌ `X-Frame-Options: DENY` |

So, **is it really a PWA?** Not quite yet. The name refers to the *bootstrap* (the "loader") of a Progressive Web App. You can't register a service worker or persist data from that origin, but you get JavaScript, network access and a stable, owner-controlled URL that nobody can edit except the account holder. Our three examples use that: a plain page, a packed page, and a page that talks to the ledger.

### 7. Verifying what you were served: `pwa_validate`

A node could serve you something other than what's on the ledger. To check, xahaud adds a public RPC, [`pwa_validate`](https://xahau.network/docs/features/http-websocket-apis/pwa-validate/). You send it the account and the **SHA-512Half** of the bytes you received, and it answers against its validated ledger:

```json
{ "command": "pwa_validate", "account": "r...", "hash": "<SHA-512Half hex>", "domain": "app.example.org" }
```

The response includes `valid`, `ledger_index`, `app_loader_sequence` and, when invalid, a `reason` (`"no loader"`, `"hash mismatch"` or `"domain not endorsed by account"`). The `X-LedgerSeq` header tells you which ledger the page came from. If that ledger is older than `ledger_index` and you get a hash mismatch, the page was just updated, so reload. A browser extension could run this check against a second, independent node on every visit. There is also an admin-only `pwa_info` for operators (request counters, DNS cache).

---

## Setup

You need **Node.js 18 or later** (the scripts use the built-in `fetch`). Everything is run from a terminal inside the project folder.

### The network: Testnet and pwa.exposed

Publishing only needs a node with PWALoader enabled. **Serving** needs a node that runs a `pwa` port for that network, and on Testnet that's the public portal at `pwa.exposed`:

```
https://pwa.exposed/<r-address>                  301 redirect
https://pwa<AccountIndex>.pwa.exposed/<r-address> the page
```

To use a different network or your own node, you only need to change `WSS_URL`, `FAUCET_URL`, `PWA_ZONE` and `EXPLORER_URL` in `.env` (step 2). One detail if you reuse code from the RNG article: the Testnet faucet hands out **secp256k1** seeds, and xahau.js doesn't infer that from the seed, so `lib/config.js` picks the algorithm from the seed prefix (`sEd…` is Ed25519).

### Step 1: Get the code and install the dependencies

```bash
git clone https://github.com/Ekiserrepe/learnxahau-pwa
cd learnxahau-pwa
npm install
```

`npm install` reads `package.json` and installs [xahau.js](https://www.npmjs.com/package/xahau), `dotenv` (to read the `.env` file) and `qrcode` (used by the links page):

`package.json`

```json
{
  "name": "learnxahau-pwa",
  "version": "1.0.0",
  "description": "Learning Xahau: on-ledger web apps with the PWALoader amendment (a links page, a game, a live ledger dashboard and a verified remote loader) using xahau.js 4.2.0",
  "license": "MIT",
  "private": true,
  "dependencies": {
    "dotenv": "^16.4.5",
    "qrcode": "^1.5.4",
    "xahau": "4.2.0"
  }
}
```

### Step 2: Create your `.env` file

The scripts read their settings (network, PWA portal and one seed per app) from a `.env` file. Start from the example:

```bash
cp .env.example .env
```

`.env.example`

```bash
# Xahau Testnet (network 21338, PWALoader enabled, public PWA portal at pwa.exposed). Run `node 00-create-accounts.js`
# to create the accounts below with the faucet and fill this file for you
WSS_URL=wss://xahau-test.net
FAUCET_URL=https://xahau-test.net/newcreds
PWA_ZONE=pwa.exposed              # documents are served at https://pwa<AccountIndex>.<PWA_ZONE>/<r-address>
EXPLORER_URL=https://explorer.xahau-test.net
VERIFY_WSS_URL=                  # optional second node for 05-verify.js (defaults to WSS_URL)

# One account per app: an account holds at most one AppLoader
LINKS_SEED=       # apps/links   - the links page
GAME_SEED=        # apps/game    - Flappy Hook
LEDGER_SEED=      # apps/ledger  - live ledger dashboard
```

Each app needs **its own account**, because an account can hold only one page. `lib/config.js` maps each app name to its seed. That's why every script takes the app name as an argument (`links`, `game` or `ledger`):

`lib/config.js`

```javascript
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
```

### Step 3: Create and fund the three accounts

You can paste three Testnet seeds into `.env` yourself, or let this script ask the faucet for them. It writes the seeds into `.env` and prints the balances. The Testnet faucet gives one account per minute, so it takes about two minutes:

```bash
node 00-create-accounts.js
```

`00-create-accounts.js`

```javascript
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
```

```
$ node 00-create-accounts.js
Creating 3 accounts. It takes about 120s because of the faucet cooldown.

LINKS_SEED   rsHcmQM3LxjxUpLgBzUzbvzVDTyD7p1s2C  (+1000 XAH)
  Waiting 60s for the faucet cooldown...
GAME_SEED    r9KrqiUab4za8YCJPAZPNc1NeFFowMDzt3  (+1000 XAH)
  Waiting 60s for the faucet cooldown...
LEDGER_SEED  rwEKoNJXBZtoo2U1caroJCPsBBK1DfHZim  (+1000 XAH)

Balances:
LINKS_SEED   rsHcmQM3LxjxUpLgBzUzbvzVDTyD7p1s2C  1000 XAH
GAME_SEED    r9KrqiUab4za8YCJPAZPNc1NeFFowMDzt3  1000 XAH
LEDGER_SEED  rwEKoNJXBZtoo2U1caroJCPsBBK1DfHZim  1000 XAH
```

If it stops halfway, run it again: it keeps the seeds already in `.env` and only creates the missing ones.

### Step 4: Check the network

Before publishing anything, make sure PWALoader is enabled on the node you're connected to and that the PWA portal answers:

```bash
node 01-check-pwa.js
```

`01-check-pwa.js`

```javascript
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
```

```
$ node 01-check-pwa.js
Node:       wss://xahau-test.net
Build:      2026.10.16-tmp-dev
Network ID: 21338
PWALoader:  enabled

Base fee:   10 drops
Document:   up to 4096 bytes, +1 drop per byte
Max fee:    4106 drops (0.004106 XAH) for a full 4 KB page

PWA zone:   https://pwa.exposed answered 404 (looks like a pwa port)
```

## The Toolkit: Validator and Packer

Before the apps, here is the helper every script uses. xahau.js 4.2.0 already knows the new field, the `AppLoader` object and `pwa_validate`, but it has no helpers for working with the page itself, so we add them:

- **`validate()`**: a line-by-line JavaScript port of xahaud's `appLoader::validate()` and `isValidUTF8()`. xahau.js only checks that `AppLoader` is hex and at most 4096 bytes, and the node answers a bad page with a plain `temMALFORMED` that doesn't say which rule failed (no fee is charged, since `tem` errors never reach a ledger). Checking locally tells you exactly what's wrong before you submit. To make sure the port is exact, I compiled the original C++ and fuzzed both with 60,000 generated documents (doctypes, broken `</html` tags, BOMs, overlong UTF-8, surrogates, control characters…). There were **zero mismatches**.
- **`pack()`**: 4096 bytes is tight. HTML compresses well, so `pack()` deflates the whole page, base64-encodes it and wraps it in a ~350-byte stub. In the browser, the stub inflates it with the native `DecompressionStream` and writes it over itself with `document.write`. Base64 never contains `<`, so the stub's own `</html>` is always the last one the validator sees. This trick comes from **[ShortTheFomo](https://github.com/shortthefomo)**, whose [bootloader-games](https://github.com/shortthefomo/bootloader-games) proof of concept uses it to fit a whole Tetris on the ledger. Our `pack()` is a generalised version: it compresses any HTML page instead of a game's JavaScript.
- **`sha512Half()`** for `pwa_validate`, and **`pwaUrl()`**, which converts the hex `AccountIndex` into the decimal host label.

`lib/apploader.js`

```javascript
// Helpers shared by the scripts: the AppLoader validator, the packer and a few utilities.
const crypto = require('crypto')
const zlib = require('zlib')

// include/xrpl/protocol/Protocol.h: maxAppLoaderLength and appLoaderFeeDropsPerByte
const MAX_APP_LOADER_BYTES = 4096
const FEE_DROPS_PER_BYTE = 1

// HTML "ASCII whitespace": TAB, LF, FF, CR, SPACE
const isSpace = c => c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20
const lower = c => (c >= 0x41 && c <= 0x5a ? c + 32 : c)
const isTagNameEnd = c => isSpace(c) || c === 0x3e /* > */ || c === 0x2f /* / */

function matchAt(data, pos, lit) {
  if (pos > data.length || data.length - pos < lit.length) return false
  for (let i = 0; i < lit.length; i++) if (lower(data[pos + i]) !== lit.charCodeAt(i)) return false
  return true
}

function findFrom(data, from, lit) {
  for (let i = from; i + lit.length <= data.length; i++) if (matchAt(data, i, lit)) return i
  return data.length
}

// Port of isValidUTF8() in src/libxrpl/basics/UTF8.cpp (Markus Kuhn's utf8_check).
// Stricter than TextDecoder: it also refuses U+FFFE and U+FFFF
function isValidUTF8(s) {
  let i = 0
  while (i < s.length) {
    const c0 = s[i]
    if (c0 < 0x80) {
      i++
    } else if ((c0 & 0xe0) === 0xc0) {
      if (s.length - i < 2 || (s[i + 1] & 0xc0) !== 0x80 || (c0 & 0xfe) === 0xc0) return false
      i += 2
    } else if ((c0 & 0xf0) === 0xe0) {
      const c1 = s[i + 1]
      if (s.length - i < 3 || (c1 & 0xc0) !== 0x80 || (s[i + 2] & 0xc0) !== 0x80) return false
      if (c0 === 0xe0 && (c1 & 0xe0) === 0x80) return false // overlong
      if (c0 === 0xed && (c1 & 0xe0) === 0xa0) return false // UTF-16 surrogate
      if (c0 === 0xef && c1 === 0xbf && (s[i + 2] & 0xfe) === 0xbe) return false // U+FFFE or U+FFFF
      i += 3
    } else if ((c0 & 0xf8) === 0xf0) {
      const c1 = s[i + 1]
      if (s.length - i < 4 || (c1 & 0xc0) !== 0x80 || (s[i + 2] & 0xc0) !== 0x80 || (s[i + 3] & 0xc0) !== 0x80) return false
      if (c0 === 0xf0 && (c1 & 0xf0) === 0x80) return false // overlong
      if (c0 > 0xf4 || (c0 === 0xf4 && c1 > 0x8f)) return false // > U+10FFFF
      i += 4
    } else {
      return false // stray continuation byte or 0xF8..0xFF
    }
  }
  return true
}

// A line-by-line port of appLoader::validate() in src/libxrpl/protocol/AppLoader.cpp.
// The node only answers temMALFORMED; running it locally tells you which rule failed.
function validate(data) {
  if (!data || data.length === 0) return 'empty document'
  if (data.length > MAX_APP_LOADER_BYTES) return 'document exceeds maxAppLoaderLength'
  if (!isValidUTF8(data)) return 'malformed UTF-8'
  for (const c of data) if (!isSpace(c) && (c < 0x20 || c === 0x7f)) return 'forbidden control character'

  let begin = 0
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) begin = 3
  while (begin < data.length && isSpace(data[begin])) begin++
  if (begin === data.length) return 'empty document'

  const doctype = matchAt(data, begin, '<!doctype') && begin + 9 < data.length && isSpace(data[begin + 9])
  const html = matchAt(data, begin, '<html') && begin + 5 < data.length && isTagNameEnd(data[begin + 5])
  if (!doctype && !html) return 'does not open with a doctype or <html> tag'

  let open = begin
  for (;;) {
    open = findFrom(data, open, '<html')
    if (open === data.length) return 'missing <html> start tag'
    if (open + 5 < data.length && isTagNameEnd(data[open + 5])) break
    open++
  }

  // The LAST well-formed </html>, so that one quoted inside a script does not shadow the real one
  let closeEnd = 0
  for (let probe = open; ;) {
    const found = findFrom(data, probe, '</html')
    if (found === data.length) break
    let j = found + 6
    while (j < data.length && isSpace(data[j])) j++
    if (j < data.length && data[j] === 0x3e) closeEnd = j + 1
    probe = found + 1
  }
  if (closeEnd === 0) return 'missing or misplaced </html> end tag'

  for (let i = closeEnd; i < data.length; i++) if (!isSpace(data[i])) return 'content after </html>'
  return 'ok'
}

// ShortTheFomo's packing trick (github.com/shortthefomo/bootloader-games), generalised to any page.
// Wraps a whole HTML document in a tiny self-inflating stub: the ledger stores
// deflate-raw + base64 of the page, and the browser unpacks it and writes it over the stub.
// Base64 never contains "<", so the stub's own </html> stays the last one the validator sees.
function pack(html, title = 'App') {
  const b64 = zlib.deflateRawSync(Buffer.from(html), { level: 9 }).toString('base64')
  const stub =
    '<!doctype html><html><head><meta charset=utf-8>' +
    '<meta name=viewport content="width=device-width,initial-scale=1">' +
    `<title>${title}</title></head><body><script>` +
    `const z="${b64}";` +
    'new Response(new Blob([Uint8Array.from(atob(z),c=>c.charCodeAt(0))]).stream()' +
    '.pipeThrough(new DecompressionStream("deflate-raw"))).text()' +
    '.then(h=>{document.open();document.write(h);document.close()})' +
    '</script></body></html>'
  return Buffer.from(stub)
}

// The hash pwa_validate expects: SHA-512Half (first 32 bytes of SHA-512), hex
const sha512Half = data => crypto.createHash('sha512').update(data).digest().subarray(0, 32).toString('hex').toUpperCase()

// AccountIndex is a UInt64, so JSON shows it in hex; the host label uses it in decimal
const pwaUrl = (zone, accountIndexHex, address) => `https://pwa${BigInt('0x' + accountIndexHex)}.${zone}/${address}`

const hexToBuffer = hex => Buffer.from(hex, 'hex')

module.exports = { MAX_APP_LOADER_BYTES, FEE_DROPS_PER_BYTE, validate, pack, sha512Half, pwaUrl, hexToBuffer }
```

## The Scripts

Every app goes through the same steps. These are the commands, with `<app>` being `links`, `game` or `ledger`:

| Step | Command | What it does |
|---|---|---|
| Build | `node 02-build.js <app>` | Turns `apps/<app>/index.html` into `build/<app>.html`, the exact bytes for the ledger |
| Publish | `node 03-publish.js <app>` | Sends the `AccountSet` with `AppLoader` and prints the page URL |
| Read | `node 04-read.js <app or r-address>` | Downloads any page from the ledger into `build/` |
| Verify | `node 05-verify.js <app or r-address>` | Fetches the page from the portal and checks it with `pwa_validate` |
| Remove | `node 06-remove.js <app>` | Deletes the page with an empty `AppLoader` |

To **update** a page, edit its `index.html` and run build and publish again. The overwrite costs the same per-byte fee, and `AppLoaderSequence` goes up by one.

Below is each script, using the links page as the example.

### Build: from source to ledger-ready bytes

`02-build.js` takes `apps/<app>/index.html`, fills in build-time settings (the page can't read your `.env` or the node's headers), validates the result and packs it if it doesn't fit. Nothing is sent to the network yet:

```bash
node 02-build.js links          # build/links.html
node 02-build.js game --pack    # --pack compresses even if the page already fits
```

`02-build.js`

```javascript
// Turns apps/<app>/index.html into build/<app>.html, the exact bytes that go on the ledger.
//   node 02-build.js <links|game|ledger> [--pack]
// Pages that do not fit in 4096 bytes (or with --pack) are compressed into a self-inflating stub.
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const QRCode = require('qrcode')
const { appName, WSS_URL } = require('./lib/config')
const { MAX_APP_LOADER_BYTES, FEE_DROPS_PER_BYTE, validate, pack } = require('./lib/apploader')

async function build() {
  const app = appName(process.argv[2])
  const forcePack = process.argv.includes('--pack')
  let html = fs.readFileSync(path.join(__dirname, 'apps', app, 'index.html'), 'utf8')

  // Build-time settings: a served page cannot read the node's headers or our .env
  html = html.replaceAll('__WSS_URL__', WSS_URL)

  if (app === 'links') {
    // A QR library would not fit in 4 KB: encode the QR here and ship only its modules,
    // 4 per hex digit, row by row
    const tip = /const TIP = '(\w+)'/.exec(html)[1]
    const { modules } = QRCode.create(tip, { errorCorrectionLevel: 'M' })
    let bits = ''
    for (let i = 0; i < modules.data.length; i += 4) {
      bits += ((modules.data[i] << 3) | (modules.data[i + 1] << 2) | (modules.data[i + 2] << 1) | (modules.data[i + 3] | 0)).toString(16)
    }
    console.log(`Tip QR:     ${tip}, ${modules.size}x${modules.size} modules in ${bits.length} hex digits`)
    html = html.replace('__QR_SIZE__', modules.size).replace('__QR_BITS__', bits)
  }

  const raw = Buffer.from(html)
  const title = (/<title>([^<]*)<\/title>/.exec(html) || [])[1] || app
  const packed = pack(html, title)
  console.log(`Source:     ${raw.length} bytes (${validate(raw)})`)
  console.log(`Packed:     ${packed.length} bytes (${validate(packed)})`)

  const usePacked = forcePack || raw.length > MAX_APP_LOADER_BYTES
  const doc = usePacked ? packed : raw
  const verdict = validate(doc)
  if (verdict !== 'ok') throw new Error(`The ledger would reject this document: ${verdict}`)

  fs.mkdirSync(path.join(__dirname, 'build'), { recursive: true })
  const out = path.join(__dirname, 'build', `${app}.html`)
  fs.writeFileSync(out, doc)
  console.log(`\nWrote ${path.relative(__dirname, out)}: ${doc.length} / ${MAX_APP_LOADER_BYTES} bytes, ${usePacked ? 'packed' : 'as is'}`)
  console.log(`Extra fee:  ${doc.length * FEE_DROPS_PER_BYTE} drops on top of the base fee`)
}

build().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
```

### Publish: one `AccountSet`

Run it after the build. It signs with the app's seed from `.env`, waits for validation and then waits until the portal serves the exact same bytes:

```bash
node 03-publish.js links
```

`03-publish.js`

```javascript
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
```

```
$ node 02-build.js links && node 03-publish.js links
Tip QR:     rf1NrYAsv92UPDd8nyCG4A3bez7dhYE61r, 29x29 modules in 211 hex digits
Source:     4059 bytes (ok)
Packed:     3289 bytes (ok)

Wrote build/links.html: 4059 / 4096 bytes, as is
Extra fee:  4059 drops on top of the base fee
Account:  rsHcmQM3LxjxUpLgBzUzbvzVDTyD7p1s2C
Document: 4059 bytes
Fee:      4069 drops
AccountSet: tesSUCCESS
Explorer:   https://explorer.xahau-test.net/tx/46B8793F370F91CCA3C223C157AED942C11A97E5226BF09A7434369396EC7BF8
AppLoaderSequence: 1

Live at:  https://pwa32761.pwa.exposed/rsHcmQM3LxjxUpLgBzUzbvzVDTyD7p1s2C
```

The fee is exactly `10 + 4059` drops. The account's `AccountIndex` was `0x7ff9`, so the page lives at `pwa32761`.

### Read: any page, straight from the ledger

You don't need a `pwa` port to read a page. Any node answers `ledger_entry` with the `app_loader` selector. Pass an app name to read your own page, or any r-address to read someone else's:

```bash
node 04-read.js links
node 04-read.js rsHcmQM3LxjxUpLgBzUzbvzVDTyD7p1s2C
```

`04-read.js`

```javascript
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
```

```
$ node 04-read.js links
{
  "AppLoader": "<4059 bytes>",
  "AppLoaderSequence": 1,
  "Flags": 0,
  "LedgerEntryType": "AppLoader",
  "Owner": "rsHcmQM3LxjxUpLgBzUzbvzVDTyD7p1s2C",
  "PreviousTxnID": "46B8793F370F91CCA3C223C157AED942C11A97E5226BF09A7434369396EC7BF8",
  "PreviousTxnLgrSeq": 13272084,
  "index": "AFF3957A86E70A28AE56F85851C86C9F2FDA7CA363EAB2218A0402B4908CC7A5"
}

Validator:   ok
SHA-512Half: DFD6B068410A71BE2AF6B1B505587D902E3ED14EA9CF53CBE329BD0057233E05
URL:         https://pwa32761.pwa.exposed/rsHcmQM3LxjxUpLgBzUzbvzVDTyD7p1s2C
Saved:       build/read-rsHcmQM3LxjxUpLgBzUzbvzVDTyD7p1s2C.html
```

### Verify: fetch like a browser, check like a skeptic

This downloads the page from the portal, shows its headers, and asks a node whether those bytes are the account's current page. To check against a different node from the one in `WSS_URL`, set `VERIFY_WSS_URL` in `.env`:

```bash
node 05-verify.js links
```

`05-verify.js`

```javascript
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
```

```
$ node 05-verify.js links
GET https://pwa32761.pwa.exposed/rsHcmQM3LxjxUpLgBzUzbvzVDTyD7p1s2C
200 OK
  content-type: text/html; charset=utf-8
  content-security-policy: sandbox allow-scripts allow-forms allow-popups
  x-frame-options: DENY
  cache-control: no-cache
  etag: null
  x-networkid: 21338
  x-ledgerseq: 13272093
  x-ledgerhash: E98111312D6394808C8ABE1E62B229A3BB49CFACE952EB0E1A3FA8C0C542996D
  x-pwaseq: 1

pwa_validate (4059 bytes, SHA-512Half DFD6B068410A71BE...)
{
  "app_loader_sequence": 1,
  "ledger_index": 13272093,
  "valid": true
}

If-None-Match: "46B8793F370F91CCA3C223C157AED942C11A97E5226BF09A7434369396EC7BF8"
→ 304 Not Modified
```

Notice `etag: null`. The portal sits behind Cloudflare, which stripped the header, but the node still honours `If-None-Match` with the `PreviousTxnID`. This is a good reminder that the proxy in front of a `pwa` port is part of what you're trusting.

### Remove

```bash
node 06-remove.js links
```

`06-remove.js`

```javascript
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
```

```
$ node 06-remove.js links
AccountSet: tesSUCCESS (fee 10 drops)
AppLoaderSequence: 2
```

After that, `ledger_entry` returns `entryNotFound` and the URL answers `404`. To bring the page back, run `node 03-publish.js links` again (the `build/links.html` from before is still there).

---

## Example 1: A Links Page (Linktree Style)

The classic "link in bio" page, hosted by the ledger instead of a SaaS, with a tip box that includes a **QR code Xaman can scan**. It is 4,059 bytes, just under the limit, so it goes on-ledger **as is**: anyone who reads the `AppLoader` object sees readable HTML.

Two details are worth explaining:

- **No `target="_blank"`.** A popup opened from a sandboxed page *inherits the sandbox*, so the site you link to would open with broken storage and cookies. A plain navigation leaves the sandbox behind.
- **A QR code without a QR library.** A QR encoder alone weighs more than our entire 4 KB budget. Since the tip address is fixed, `02-build.js` encodes the QR on your machine (with the [`qrcode`](https://www.npmjs.com/package/qrcode) npm package) and writes only its modules into the page: 29×29 modules, 4 per hex digit, **211 characters**. In the browser, a 10-line loop turns them into an SVG path. The QR is drawn on white with a quiet zone, so phones can read it in dark mode too. I checked it with Chrome's built-in `BarcodeDetector`, which decodes it back to the address.

The page lives in `apps/links/index.html`:

`apps/links/index.html`

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ekiserrepé · Links</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--line:#30363d;--fg:#e6edf3;--dim:#8b949e;--acc:#f0b90b}
@media (prefers-color-scheme:light){:root{--bg:#f6f8fa;--card:#fff;--line:#d0d7de;--fg:#1f2328;--dim:#59636e;--acc:#b07d00}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--fg);font:16px/1.4 system-ui,sans-serif;display:flex;justify-content:center;padding:48px 16px}
main{width:100%;max-width:440px;text-align:center}
.av{width:96px;height:96px;margin:0 auto 12px;border-radius:50%;display:grid;place-items:center;font:700 36px system-ui;color:#000;background:linear-gradient(135deg,#f0b90b,#ff6b6b)}
h1{font-size:22px;margin:0}
p{color:var(--dim);margin:6px 0 28px}
a.l{display:flex;align-items:center;gap:12px;padding:14px 18px;margin:10px 0;border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--fg);text-decoration:none;font-weight:600;transition:transform .15s,border-color .15s}
a.l:hover{transform:translateY(-2px);border-color:var(--acc)}
a.l span{font-size:20px;width:28px}
.tip{margin-top:28px;padding:14px;border:1px dashed var(--line);border-radius:12px;font-size:13px;color:var(--dim)}
code{display:block;margin:8px 0;color:var(--fg);word-break:break-all;font-size:12px}
#qr{display:block;width:168px;margin:10px auto;border-radius:8px}
button{font:600 13px system-ui;padding:8px 14px;border-radius:8px;border:0;background:var(--acc);color:#000;cursor:pointer}
footer{margin-top:32px;font-size:12px;color:var(--dim)}
footer b{color:var(--acc)}
</style>
</head>
<body>
<main>
<div class="av">E</div>
<h1>Ekiserrepé</h1>
<p>Building on Xahau · Learning Xahau series</p>
<nav id="links"></nav>
<div class="tip">Tip me in XAH<svg id="qr"></svg><code id="addr"></code><button id="copy">Copy address</button></div>
<footer>Served from <b>Xahau</b> · AppLoader of this account</footer>
</main>
<script>
// Edit this list: [icon, label, url]
const LINKS = [
  ['📝', 'Learning Xahau on dev.to', 'https://dev.to/ekiserrepe/series/31668'],
  ['💻', 'GitHub', 'https://github.com/Ekiserrepe'],
  ['📚', 'Xahau docs', 'https://xahau.network/docs/'],
  ['🛠️', 'xahaud source', 'https://github.com/Xahau/xahaud']
]

const nav = document.getElementById('links')
for (const [icon, label, url] of LINKS) {
  const a = document.createElement('a')
  a.className = 'l'
  // No target="_blank": popups inherit this page's sandbox, a plain navigation does not
  a.href = url
  a.innerHTML = '<span></span>'
  a.firstChild.textContent = icon
  a.append(label)
  nav.append(a)
}

// Where tips go. 02-build.js turns it into a QR code (QR_BITS) that Xaman can scan
const TIP = 'rf1NrYAsv92UPDd8nyCG4A3bez7dhYE61r'
const QR_SIZE = __QR_SIZE__
const QR_BITS = '__QR_BITS__'

const addr = document.getElementById('addr')
addr.textContent = TIP

// One hex digit holds 4 modules, row by row. Draw each dark module as a 1x1 square,
// inside a 4-module quiet zone on white so phones can read it in dark mode too
let d = ''
for (let i = 0; i < QR_SIZE * QR_SIZE; i++) {
  if (parseInt(QR_BITS[i >> 2], 16) >> (3 - i % 4) & 1) d += `M${i % QR_SIZE + 4} ${(i / QR_SIZE | 0) + 4}h1v1h-1z`
}
const qr = document.getElementById('qr')
qr.setAttribute('viewBox', `0 0 ${QR_SIZE + 8} ${QR_SIZE + 8}`)
qr.innerHTML = `<rect width="100%" height="100%" fill="#fff"/><path d="${d}"/>`

document.getElementById('copy').onclick = async e => {
  try {
    await navigator.clipboard.writeText(TIP)
    e.target.textContent = 'Copied!'
  } catch {
    // The clipboard API may be blocked in a sandboxed page: select the text instead
    getSelection().selectAllChildren(addr)
    e.target.textContent = 'Press Ctrl/Cmd+C'
  }
}
</script>
</body>
</html>
```

**Try it yourself:**

1. Edit `apps/links/index.html`: your name, the `LINKS` list and the `TIP` address. The QR is generated from `TIP` automatically.
2. Build it. Check that it says `as is` or `packed` and stays under 4096 bytes:
   ```bash
   node 02-build.js links
   ```
3. Publish it:
   ```bash
   node 03-publish.js links
   ```
4. Open the `Live at:` URL it prints. If you change something, repeat steps 2 and 3.

Live on Testnet: `https://pwa32761.pwa.exposed/rsHcmQM3LxjxUpLgBzUzbvzVDTyD7p1s2C`

## Example 2: A Game (Flappy Hook)

A Flappy Bird–style game starring a Hook 🪝. Tap, click or press Space to flap, and fly through the gaps between the ledger blocks. Hit one and your ledger gets rejected. It's all canvas: the hook, the pipes and the ground are drawn with a handful of paths and rectangles, with no images to download. The source is **4,763 bytes**, too big for the ledger, so `02-build.js` packs it into **3,356 bytes** with [ShortTheFomo](https://github.com/shortthefomo)'s packing trick (see `pack()` in the Toolkit).

The game lives in `apps/game/index.html`:

`apps/game/index.html`

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<title>Flappy Hook</title>
<style>
html,body{margin:0;height:100%;background:#0b0f17;overflow:hidden}
body{display:grid;place-items:center;font:14px system-ui,sans-serif;color:#e6edf3;user-select:none;touch-action:manipulation}
canvas{height:min(100vh,177vw);aspect-ratio:9/16;display:block;cursor:pointer}
</style>
</head>
<body>
<canvas id="c" width="360" height="640"></canvas>
<script>
const cv = document.getElementById('c'), g = cv.getContext('2d')
const W = 360, H = 640, GROUND = 590
const GAP = 160, PIPE_W = 62, SPEED = 2.4, GRAVITY = 0.42, FLAP = -7.6

// The page runs in a sandbox with an opaque origin: localStorage throws,
// so the best score only lives as long as the tab
let best = 0
try { best = +localStorage.best || 0 } catch {}

let hook, pipes, score, state, frame

function reset() {
  hook = { y: H / 2 - 40, v: 0 }
  pipes = []
  score = 0
  frame = 0
  state = 'ready'
}

function flap() {
  if (state === 'over') {
    // A short pause so a frantic tap does not restart straight away
    if (frame > 30) reset()
    return
  }
  state = 'play'
  hook.v = FLAP
}

function update() {
  frame++
  if (state === 'ready') {
    hook.y = H / 2 - 40 + Math.sin(frame / 12) * 8 // bob while waiting
    return
  }
  if (state === 'over') {
    if (hook.y < GROUND - 20) { hook.v += GRAVITY; hook.y += hook.v }
    return
  }
  hook.v += GRAVITY
  hook.y += hook.v

  // A new pair of pipes every 95 frames, the gap somewhere in the middle
  if (frame % 95 === 0) pipes.push({ x: W, gap: 120 + Math.random() * (GROUND - GAP - 200), passed: false })
  for (const p of pipes) {
    p.x -= SPEED
    if (!p.passed && p.x + PIPE_W < 90) {
      p.passed = true
      score++
    }
    // The hook is roughly a 28x40 box at x = 76..104
    const inX = 104 > p.x && 76 < p.x + PIPE_W
    const inGap = hook.y - 18 > p.gap && hook.y + 22 < p.gap + GAP
    if (inX && !inGap) die()
  }
  pipes = pipes.filter(p => p.x > -PIPE_W)
  if (hook.y + 22 > GROUND || hook.y < -40) die()
}

function die() {
  state = 'over'
  frame = 0
  if (score > best) {
    best = score
    try { localStorage.best = best } catch {}
  }
}

function drawHook(x, y, angle) {
  g.save()
  g.translate(x, y)
  g.rotate(angle)
  g.strokeStyle = '#f0b90b'
  g.lineWidth = 6
  g.lineCap = 'round'
  // Eye, shank and bend of a fishing hook
  g.beginPath()
  g.arc(0, -16, 5, 0, 7)
  g.moveTo(0, -11)
  g.lineTo(0, 10)
  g.arc(-9, 10, 9, 0, Math.PI)
  g.lineTo(-18, 2)
  g.stroke()
  // The barb
  g.beginPath()
  g.moveTo(-18, 2)
  g.lineTo(-12, 6)
  g.stroke()
  g.restore()
}

function text(t, y, size, color = '#fff') {
  g.font = `800 ${size}px system-ui,sans-serif`
  g.textAlign = 'center'
  g.lineWidth = 6
  g.strokeStyle = '#0b0f17'
  g.strokeText(t, W / 2, y)
  g.fillStyle = color
  g.fillText(t, W / 2, y)
}

function draw() {
  // Night sky
  const sky = g.createLinearGradient(0, 0, 0, H)
  sky.addColorStop(0, '#0d1b2a')
  sky.addColorStop(1, '#1b3a4b')
  g.fillStyle = sky
  g.fillRect(0, 0, W, H)

  // Pipes, labelled like ledger blocks
  for (const p of pipes) {
    g.fillStyle = '#2dd4bf'
    g.fillRect(p.x, 0, PIPE_W, p.gap)
    g.fillRect(p.x, p.gap + GAP, PIPE_W, GROUND - p.gap - GAP)
    g.fillStyle = '#14b8a6'
    g.fillRect(p.x - 4, p.gap - 22, PIPE_W + 8, 22)
    g.fillRect(p.x - 4, p.gap + GAP, PIPE_W + 8, 22)
  }

  // Ground scrolls with the pipes
  g.fillStyle = '#0f766e'
  g.fillRect(0, GROUND, W, H - GROUND)
  g.fillStyle = '#115e59'
  const shift = state === 'play' ? (frame * SPEED) % 24 : 0
  for (let x = -shift; x < W; x += 24) g.fillRect(x, GROUND, 12, 8)

  drawHook(90, hook.y, Math.max(-0.5, Math.min(1.2, hook.v / 10)))

  if (state === 'ready') {
    text('FLAPPY HOOK', 170, 40, '#f0b90b')
    text('Tap, click or press Space', 420, 18)
    if (best) text(`Best ${best}`, 450, 16, '#8b949e')
  } else {
    text(score, 80, 48)
  }
  if (state === 'over') {
    text('LEDGER REJECTED', 230, 30, '#f85149')
    text(`Score ${score}  ·  Best ${best}`, 280, 20)
    if (frame > 30) text('Tap to retry', 330, 16, '#8b949e')
  }
}

// Physics run at a fixed 60 steps per second, so 120 Hz screens are not twice as fast
let last = 0, acc = 0
function loop(now) {
  acc += Math.min(100, now - (last || now))
  last = now
  while (acc >= 1000 / 60) {
    update()
    acc -= 1000 / 60
  }
  draw()
  requestAnimationFrame(loop)
}

cv.addEventListener('pointerdown', e => { e.preventDefault(); flap() })
addEventListener('keydown', e => {
  if (e.code === 'Space' || e.code === 'ArrowUp') { e.preventDefault(); flap() }
})

reset()
requestAnimationFrame(loop)
</script>
</body>
</html>
```

**Try it yourself:**

```bash
node 02-build.js game     # packs it automatically: the source is over 4096 bytes
node 03-publish.js game   # prints the URL to play it
```

The build output shows the packing:

```
$ node 02-build.js game
Source:     4763 bytes (document exceeds maxAppLoaderLength)
Packed:     3356 bytes (ok)

Wrote build/game.html: 3356 / 4096 bytes, packed
Extra fee:  3356 drops on top of the base fee
```

This is what actually goes on the ledger: [ShortTheFomo](https://github.com/shortthefomo)'s stub and a blob of base64.

```html
<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Flappy Hook</title></head><body><script>const z="jVhtc9u4Ef7O...";new Response(new Blob([Uint8Array.from(atob(z),c=>c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text().then(h=>{document.open();document.write(h);document.close()})</script></body></html>
```

Live: `https://pwa32762.pwa.exposed/r9KrqiUab4za8YCJPAZPNc1NeFFowMDzt3`

## Example 3: A Dashboard That Reads Its Own Ledger

This one is the most "Xahau" of the three. The page is stored in the ledger, and when it opens it connects to the **same ledger over WebSocket**. It subscribes to the `ledger` stream, shows each validated ledger as it closes, and then looks itself up:

- `account_info` on its owner (from `location.pathname`): balance, `AccountIndex` (and the `pwa<N>` label it produces), `AppLoaderSequence`;
- `ledger_entry` with `app_loader` on its owner: the object it was loaded from.

The WebSocket URL is written in at build time (`__WSS_URL__`) because the page can't see which node served it. It's 4,330 bytes as source and 2,971 once packed with [ShortTheFomo](https://github.com/shortthefomo)'s trick.

The dashboard lives in `apps/ledger/index.html`:

`apps/ledger/index.html`

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Xahau Live</title>
<style>
body{margin:0;background:#0b0f17;color:#e6edf3;font:14px/1.4 system-ui,sans-serif;padding:24px 16px}
main{max-width:640px;margin:auto}
h1{font-size:18px;margin:0 0 4px}
.dim{color:#8b949e}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:18px 0}
.k{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:12px}
.k b{display:block;font-size:22px;color:#f0b90b;font-variant-numeric:tabular-nums}
h2{font-size:14px;margin:22px 0 8px}
pre{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:12px;overflow:auto;font-size:12px}
#feed div{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #21262d;font-variant-numeric:tabular-nums}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#f85149;margin-right:6px}
.on{background:#3fb950}
</style>
</head>
<body>
<main>
<h1><span id="dot" class="dot"></span>Xahau Live</h1>
<div class="dim">A dashboard stored in, and reading from, the ledger it watches. <span id="net"></span></div>
<div class="grid">
<div class="k">Validated ledger<b id="li">…</b></div>
<div class="k">Transactions<b id="tx">…</b></div>
<div class="k">Base fee (drops)<b id="fee">…</b></div>
<div class="k">Close interval<b id="ct">…</b></div>
</div>
<h2>Last ledgers</h2>
<div id="feed"></div>
<h2>This page's owner</h2>
<pre id="acct">loading…</pre>
<h2>This page's AppLoader object</h2>
<pre id="loader">loading…</pre>
</main>
<script>
// Replaced at build time with WSS_URL from .env: the page cannot see which node served it
const WSS = '__WSS_URL__'
const owner = location.pathname.replace(/\//g, '')
const $ = id => document.getElementById(id)

let ws, id = 0, lastClose
const pending = {}

// A tiny request/response layer over the WebSocket API
const request = msg => new Promise(resolve => {
  pending[++id] = resolve
  ws.send(JSON.stringify({ ...msg, id }))
})

function connect() {
  ws = new WebSocket(WSS)
  ws.onopen = async () => {
    $('dot').classList.add('on')
    const { result } = await request({ command: 'server_info' })
    $('net').textContent = `Network ${result.info.network_id} · ${result.info.build_version}`
    request({ command: 'subscribe', streams: ['ledger'] })
    showOwner()
  }
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && pending[m.id]) {
      pending[m.id](m)
      delete pending[m.id]
    } else if (m.type === 'ledgerClosed') onLedger(m)
  }
  ws.onclose = () => {
    $('dot').classList.remove('on')
    setTimeout(connect, 3000)
  }
}

function onLedger(l) {
  $('li').textContent = l.ledger_index.toLocaleString()
  $('tx').textContent = l.txn_count
  $('fee').textContent = l.fee_base
  if (lastClose) $('ct').textContent = (l.ledger_time - lastClose) + ' s'
  lastClose = l.ledger_time
  const row = document.createElement('div')
  row.innerHTML = '<span></span><span class="dim"></span>'
  row.children[0].textContent = '#' + l.ledger_index
  row.children[1].textContent = l.txn_count + ' tx · ' + new Date((l.ledger_time + 946684800) * 1000).toLocaleTimeString()
  $('feed').prepend(row)
  while ($('feed').children.length > 8) $('feed').lastChild.remove()
  showOwner()
}

async function showOwner() {
  if (!owner) return
  const info = await request({ command: 'account_info', account: owner, ledger_index: 'validated' })
  const a = info.result.account_data
  if (a) {
    $('acct').textContent = JSON.stringify({
      Account: a.Account,
      Balance: (a.Balance / 1e6) + ' XAH',
      AccountIndex: a.AccountIndex + ' (hex) = pwa' + BigInt('0x' + a.AccountIndex),
      AppLoaderSequence: a.AppLoaderSequence
    }, null, 2)
  }
  const entry = await request({ command: 'ledger_entry', app_loader: owner, ledger_index: 'validated' })
  const n = entry.result.node
  if (n) {
    $('loader').textContent = JSON.stringify({
      LedgerEntryType: n.LedgerEntryType,
      Owner: n.Owner,
      AppLoaderSequence: n.AppLoaderSequence,
      PreviousTxnID: n.PreviousTxnID,
      PreviousTxnLgrSeq: n.PreviousTxnLgrSeq,
      bytes: n.AppLoader.length / 2
    }, null, 2)
  }
}

connect()
</script>
</body>
</html>
```

**Try it yourself.** The build replaces `__WSS_URL__` with the `WSS_URL` from your `.env`, so the page connects to the same network you publish it on:

```bash
node 02-build.js ledger
node 03-publish.js ledger
```

```
$ node 02-build.js ledger && node 03-publish.js ledger
Source:     4330 bytes (document exceeds maxAppLoaderLength)
Packed:     2971 bytes (ok)

Wrote build/ledger.html: 2971 / 4096 bytes, packed
Extra fee:  2971 drops on top of the base fee
Account:  rwEKoNJXBZtoo2U1caroJCPsBBK1DfHZim
Document: 2971 bytes
Fee:      2981 drops
AccountSet: tesSUCCESS
Explorer:   https://explorer.xahau-test.net/tx/627040906AEAF8A7A8FC813FF38283C1017EFF1A8ACC00303E0912E24D534C38
AppLoaderSequence: 1

Live at:  https://pwa32765.pwa.exposed/rwEKoNJXBZtoo2U1caroJCPsBBK1DfHZim
```

Leave it open and watch a new row appear every few seconds, one per ledger.

Live: `https://pwa32765.pwa.exposed/rwEKoNJXBZtoo2U1caroJCPsBBK1DfHZim`

---

## More Ideas

PWALoader turns any account into a small, owner-controlled web origin. Some directions worth exploring:

- **A home page for your Hook.** Publish a page on the *same account* that runs the Hook: what the project or dApp is, how to use it, and its **current status**. Is the Hook live, or under maintenance? The page can read the account's Hooks and their state live from the ledger, and users know the page and the Hook belong to the same key.
- **NFT / URIToken galleries.** A page that lists the URITokens its owner holds or issued (`account_objects`) and displays them, with no indexer needed.
- **Release channels.** One account per channel (`stable`, `beta`). Your official website links to the on-ledger page, and `AppLoaderSequence` plus the transaction history give you a public changelog.
- **Status and transparency pages.** Treasury balances, reward claim history or the governance seats of an account, rendered live from the ledger.
- **Your own domain.** With a node that enables `custom_domains`, a TXT record and the account's `Domain` field, `links.yourname.com` can serve the page.

## Limitations and Safety

- **4096 bytes, in a sandbox.** No storage, no service worker, no same-origin requests. Design for that, or keep the on-ledger page small and let it load the rest from elsewhere.
- **Content is not reviewed.** Anyone can publish anything for about a drop per byte, phishing pages included. A URL on a `pwa` zone tells you which **account** published a page, not that the page is trustworthy. Check the account, and use `pwa_validate` against a node you trust.
- **Everything is public and permanent.** Removing a page deletes the object, but the old bytes stay in the transaction history. Never put secrets in a page.
- **Educational code.** Nothing here is audited or production-ready.

## Conclusion

PWALoader is a small amendment (one field, one ledger object and an opt-in HTTP mode) that changes where a Xahau app can live. Its design choices are careful: a shallow but strict validator, storage paid per byte instead of with a reserve, one origin per account, a strict sandbox, validated-state-only serving, and a public RPC so clients don't have to trust the node that served them.

The three examples cover the main patterns: a plain page, a packed page, and a page that talks to its own ledger. Clone the repo, change the links, and publish your first on-ledger page for less than half a cent.

See you in the next one!

## Resources

- Code for this article: [github.com/Ekiserrepe/learnxahau-pwa](https://github.com/Ekiserrepe/learnxahau-pwa)
- xahaud source: [github.com/Xahau/xahaud](https://github.com/Xahau/xahaud)
- Docs: [AppLoader object](https://xahau.network/docs/protocol-reference/ledger-data/ledger-objects-types/app-loader/) · [AccountSet](https://xahau.network/docs/protocol-reference/transactions/transaction-types/accountset/) · [pwa_validate](https://xahau.network/docs/features/http-websocket-apis/pwa-validate/) · [Serving PWA apps](https://xahau.network/docs/infrastructure/serving-pwa-apps/)
- xahau.js PWALoader support: [Xahau/xahau.js#81](https://github.com/Xahau/xahau.js/pull/81)
- Testnet PWA portal announcement: [Richard Holland on X](https://x.com/RichardXRPL/status/2111635759598104838)
- [ShortTheFomo](https://github.com/shortthefomo)'s packing trick and on-ledger Tetris: [shortthefomo/bootloader-games](https://github.com/shortthefomo/bootloader-games)
- Previous article: [On-Chain Randomness with the RNG Amendment](https://dev.to/ekiserrepe/learning-xahau-on-chain-randomness-with-the-rng-amendment-1b9m)
