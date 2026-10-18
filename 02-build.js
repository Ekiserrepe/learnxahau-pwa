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
