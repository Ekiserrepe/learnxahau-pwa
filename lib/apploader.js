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
