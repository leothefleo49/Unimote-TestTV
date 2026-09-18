# 📺 Unimote TestTV

Turn your PC into **five TVs at once** — Roku, Samsung, LG webOS, Vizio, and Sony — so you can test [Unimote X](https://github.com/leothefleo49/Unimote-X) connectivity, pairing, reconnection, casting, and **every single button**, with zero real hardware.

It speaks the **real protocols** the app uses (not mocks of Unimote's code): Roku ECP, Samsung's Tizen remote WebSocket with pairing tokens, LG's SSAP WebSocket handshake + pointer-input socket, Vizio's SmartCast PIN-pairing with an `AUTH` token, Sony's JSON-RPC + IRCC SOAP — plus a Cast receiver info endpoint and a real Wake-on-LAN UDP listener.

**Zero dependencies.** `git clone`, `node tv.js`, done.

---

## Quick start

```bash
git clone https://github.com/leothefleo49/Unimote-TestTV.git
cd Unimote-TestTV
node tv.js
```

On startup it prints your PC's LAN IP and the dashboard URL:

```
  Point Unimote (manual IP) at:  192.168.1.42
  Dashboard:  http://localhost:8520
```

Then:

1. Open **the dashboard** (`http://localhost:8520`) — keep it visible.
2. On your phone, open **Unimote X** → Settings → Connect.
3. Enter your **PC's LAN IP** (the dashboard shows it) and pick a brand — or hit **Auto-Scan**; the scanner will discover the simulator TVs on your network.
4. Mash buttons. The dashboard's TV screen reacts (volume bar, app launches, power state) and the **coverage checklists** light up chip-by-chip.

> **Why local and not Vercel?** TVs speak LAN protocols (raw TCP/WebSocket/UDP on specific ports). Vercel is HTTP-only serverless and your phone couldn't reach it like a TV. This runs as a plain Node process on your PC — that's the point.

## Ports

| Brand | Port | Protocol | Notes |
|---|---|---|---|
| Roku | `8060` | HTTP (ECP) | device-info XML, keypress, launch, search |
| Samsung | `8001` | HTTP + **WebSocket** | real token pairing (`ms.channel.connect`), keys, `RunApp` |
| LG webOS | `3000` / `3001` | **WebSocket** | SSAP register + client-key, `ssap://` commands, pointer-input socket |
| Vizio | `7345` | HTTP | 401 until PIN pairing; `AUTH` header; key_command |
| Sony | `80` | HTTP | `/sony/system` JSON-RPC + `/sony/IRCC` SOAP |
| Cast info | `8008` | HTTP | `eureka_info` (makes the scanner find an "Android TV") |
| Dashboard | `8520` | HTTP + SSE | live screen, log, coverage, controls |
| Wake-on-LAN | UDP `9`/`7` | UDP | magic packet powers the TV back on (MAC `AA:BB:CC:DD:EE:FF`) |

Every port has an env override (`ROKU_PORT`, `SAMSUNG_PORT`, `LG_PORT`, `LG_POINTER_PORT`, `VIZIO_PORT`, `SONY_PORT`, `CAST_PORT`, `DASH_PORT`). Port `80` (Sony) may need an Administrator terminal on Windows; or run `set SONY_PORT=8080 && node tv.js sony`.

Start a subset: `node tv.js roku vizio`

## What you can test

- **Pairing flows** — Samsung issues real tokens (watch them appear in the dashboard; "Revoke all pairings" forces Unimote's automatic re-pair). LG shows a client-key handshake. Vizio displays a PIN in the dashboard (fixed `1234`, or switch to random PINs) and 401s everything until you enter it in Unimote's *Vizio Pairing* section.
- **Every button** — the coverage section lists the exact protocol message each Unimote button should produce. Green chip = verified received. Nothing turns green unless the app actually sent it correctly.
- **Casting** — Roku `/launch/837?contentId=…` deep links, Samsung `RunApp` browser deep links, LG browser launches; launches appear on the TV screen and in the log.
- **Staying connected / honesty** — use fault injection per brand:
  - `slow` — 2.5s delayed responses (does the app stay responsive and honest?)
  - `error` — 500s (does it say "the TV refused" instead of pretending?)
  - `offline` — drops every connection (does it show DISCONNECTED and offer retry?)
- **Power off / Wake-on-LAN** — power the TV off from the dashboard: every server stops responding. From the **Unimote app** (native only — browsers can't send UDP), send a Wake-on-LAN packet to `AA:BB:CC:DD:EE:FF` and watch the TV come back on and the app reconnect.
- **Screen mirroring honesty** — LG gets a real Screen Share launch; other brands should explain what to use instead of pretending.

## Firewall (first run on Windows)

Windows may prompt to allow Node on private networks — allow it, or run once as admin:

```powershell
New-NetFirewallRule -DisplayName "Unimote TestTV" -Direction Inbound -Action Allow -Program (Get-Command node).Source
```

On the phone and PC, be on the **same Wi-Fi/LAN**.

## Repo layout

```
tv.js            entry point (brand selection, port-conflict hints)
lib/minws.js     dependency-free RFC 6455 WebSocket server
lib/state.js     shared TV state + event bus + coverage checklists
lib/dash.js      dashboard (TV screen, log, coverage, faults, pairings)
tvs/roku.js      Roku ECP
tvs/samsung.js   Samsung Tizen HTTP+WS
tvs/lg.js        LG SSAP + pointer socket
tvs/vizio.js     Vizio SmartCast pairing + keys
tvs/sony.js      Sony system + IRCC
tvs/castinfo.js  Android TV / Chromecast detection endpoint
tvs/wol.js       Wake-on-LAN UDP listener
```
