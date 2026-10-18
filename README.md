# Learning Xahau: On-Ledger Web Apps with PWALoader

Companion code for the Learning Xahau article about the **PWALoader** amendment. With PWALoader, an account can store a small HTML document (up to 4096 bytes) in an `AppLoader` ledger object. Nodes that open a `pwa` port then serve that document as a web page at `https://pwa<AccountIndex>.<zone>/<r-address>`.

This repo publishes three apps:

| App | Folder | What it shows |
|-----|--------|---------------|
| Links page (Linktree style) | `apps/links` | A plain document stored as is (4,059 bytes), with a tip QR for Xaman encoded at build time |
| Flappy Hook | `apps/game` | A 4.8 KB canvas game packed into a 3.4 KB self-inflating document |
| Xahau Live | `apps/ledger` | A dashboard that connects back to the ledger it is stored on |

Everything targets the **Xahau Testnet** (network 21338, `wss://xahau-test.net`). PWALoader is enabled there, and the public PWA portal [pwa.exposed](https://pwa.exposed/) serves Testnet pages at `https://pwa<AccountIndex>.pwa.exposed/<r-address>`. You need **[xahau.js 4.2.0](https://www.npmjs.com/package/xahau)** or later.

> [!WARNING]
> Educational purposes only. This code is not production-ready and has not been audited. Anything you publish to a ledger is public and stays in its history.

## Quick start

```bash
npm install
cp .env.example .env
node 00-create-accounts.js        # optional: creates and funds the three accounts

node 01-check-pwa.js              # amendment status, fees, and the pwa zone

node 02-build.js links            # apps/links/index.html -> build/links.html (validated)
node 03-publish.js links          # AccountSet with AppLoader, then waits until it is served
node 04-read.js links             # reads the AppLoader object back from the ledger
node 05-verify.js links           # fetches the page, checks it with pwa_validate, ETag -> 304
node 06-remove.js links           # AccountSet with an empty AppLoader

node 02-build.js game   && node 03-publish.js game
node 02-build.js ledger && node 03-publish.js ledger
```

`02-build.js` packs a page automatically when it does not fit in 4096 bytes. Pass `--pack` to force packing. `04-read.js` and `05-verify.js` also take any r-address.

## Layout

```
lib/apploader.js   validator (a port of xahaud's), packer, SHA-512Half, URL helper
lib/config.js      which account publishes which app
apps/*/index.html  app sources
build/             generated documents (git-ignored)
```

`lib/apploader.js` ports `appLoader::validate()` and `isValidUTF8()` from xahaud line by line. `pack()` is [ShortTheFomo](https://github.com/shortthefomo)'s packing trick from [bootloader-games](https://github.com/shortthefomo/bootloader-games), generalised to any HTML page. I fuzzed the validator against the compiled C++ (60,000 generated documents, no mismatches), so `02-build.js` rejects locally exactly what the ledger would reject with `temMALFORMED`.

## About

Article: [Learning Xahau series on dev.to](https://dev.to/ekiserrepe/series/31668). Thanks to the Xahau core developers for PWALoader ([xahaud](https://github.com/Xahau/xahaud)).
