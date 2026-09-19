# WinTouch Bar

Control your Windows 11 PC from your iPhone over your local network — using **Electron**, **Node.js**, **Express**, and **ws WebSockets**.

- ✅ Electron desktop window named **WinTouch Bar**
- ✅ Express server on port **8787**
- ✅ Automatically finds your PC's non-loopback IPv4 LAN address
- ✅ iPhone-friendly webpage served from `public/`
- ✅ WebSocket-based real-time communication
- ✅ QR code in the Electron window for easy iPhone setup
- ✅ Random 6-digit pairing code on every launch
- ✅ Pairing screen on iPhone before controls are unlocked
- ✅ Activity log showing paired devices + incoming actions
- ✅ Dark, polished "touch strip" inspired design (no Apple trademarks or assets)
- ✅ Safe-area aware, responsive, iPhone Safari optimized
- ✅ PWA manifest + Apple mobile web app meta tags (add to Home Screen)

---

## Folder Tree

```
Win11 Touch Bar/
├── package.json          # Project config & dependencies
├── main.js               # Electron main process (window + status polling)
├── preload.js            # Bridge between Electron main & renderer
├── server.js             # Express + WebSocket server (port 8787)
├── controls.js           # Windows actions (volume, media, brightness, power…)
├── icon.js               # Runtime PNG icon generator (no image files needed)
├── desktop.html          # Electron window HTML
├── desktop.css           # Electron window styles
├── desktop.js            # Electron window logic (QR, pairing code, log)
├── public/               # iPhone-facing web app
│   ├── index.html        # Mobile webpage (pairing + controls)
│   ├── style.css         # Mobile responsive styles
│   ├── app.js            # Mobile WebSocket client
│   ├── manifest.json     # PWA manifest for Home Screen install
│   ├── icon-192.png      # Generated at startup (don't edit manually)
│   ├── icon-512.png      # Generated at startup (don't edit manually)
│   └── apple-touch-icon.png  # Generated at startup (don't edit manually)
```

---

## Requirements

- **Windows 11** (any edition)
- **Node.js 18 or newer** — [download here](https://nodejs.org)
  - Check with: `node --version`
- **npm** (installed automatically with Node.js)
  - Check with: `npm --version`
- Your **iPhone** connected to the **same Wi-Fi network** as your PC

---

## How to Run

### 1. Install dependencies

Open a terminal (Command Prompt or PowerShell) inside the project folder:

```bash
npm install
```

This installs:
- `electron` — desktop window
- `express` — local web server
- `ws` — WebSocket server
- `qrcode` — QR code generation

### 2. Start the app

```bash
npm start
```

You'll see:

- The **WinTouch Bar** desktop window
- The server's LAN address in the window (example: `http://192.168.1.25:8787`)
- A **QR code** you can scan
- A random **6-digit pairing code**

### 3. Connect your iPhone

1. Make sure your iPhone is on the **same Wi-Fi network** as your PC.
2. Open the iPhone Camera app and point it at the QR code — it will offer to open the URL.
   - Or type the LAN URL (shown in the window) into Safari manually.
3. The pairing screen appears. Enter the **6-digit code** shown in the WinTouch Bar window.
4. After a successful pairing, the control screen appears.

> **Tip:** You can add the page to your iPhone Home Screen for a full-screen app experience:
>
> 1. In Safari, tap **Share** (the box with an up arrow).
> 2. Scroll down and tap **Add to Home Screen**.
> 3. Name it "WinTouch Bar" and tap **Add**.

> **Note:** For the closest classic control-strip layout, use iPhone landscape orientation. In portrait, the immersive strip is still available but a portrait-friendly control dashboard can be toggled from the options menu.

---

## What You Can Control

| Group        | Actions                                    |
| ------------ | ------------------------------------------- |
| **Volume**   | Mute, Volume Down, Volume Up                |
| **Media**    | Previous, Play/Pause, Next                   |
| **Brightness**| Dim, Bright (laptop internal displays)       |
| **Screen**   | Turn off display                             |
| **System**   | Lock, Sleep, Empty Recycle Bin                |
| **Apps**     | Notepad, Calculator, Command Prompt (CMD)     |
| **Power**    | Restart, Shut Down, Log Off                   |

> **Cautions:**
> - **Restart / Shutdown / Log Off** will actually restart/shut down/log off your PC.
> - **Brightness** only works on laptops with a built-in display that supports WMI brightness.
> - The **pairing code changes every time the app starts** for security.

---

## How It Works

1. **main.js** starts Electron and requires `server.js`.
2. **server.js**:
   - Finds your LAN IPv4 (`os.networkInterfaces()`)
   - Starts an Express server on `0.0.0.0:8787`
   - Serves files from `public/`
   - Starts a WebSocket server (`ws`) on the same HTTP server
   - Generates a 6-digit pairing code
3. **Electron window** polls `http://127.0.0.1:8787/api/status` every second, displays the URL, pairing code and QR code, and refreshes the activity log.
4. **iPhone page** connects to `ws://<your-lan-ip>:8787` via WebSocket.
5. The phone sends a `pair` message; the server compares the code, and if it matches, marks the socket as `paired`.
6. The phone can now send `action` messages that maps to the Windows shortcuts in `controls.js`.

---

## Configuration

- **Port:** Change `PORT` in `server.js` (line ~14) if 8787 is already in use.
- **Server binding:** The server binds to `0.0.0.0`, so it is reachable from any device on your local network.

---

## Troubleshooting

| Problem | Solution |
| ------- | -------- |
| **iPhone can't reach the page** | Make sure both are on the same Wi-Fi network. Check that your PC firewall allows incoming connections on port 8787. |
| **iPhone sees "Connecting…" forever** | Close and reopen the webpage; make sure you typed the correct LAN IP (not `localhost`). |
| **Pairing code keeps failing** | The code changes on every app launch — check the WinTouch Bar window for the current code. |
| **Brightness buttons do nothing** | Brightness WMI only works for laptop built-in displays that expose it. It's a Windows limitation. |
| **QR code is blank or missing** | Rescan by restarting the app. `qrcode` might have failed on slow machines. |
| **"Failed to generate icons" in console** | The `public/` folder is auto-created, but if it already existed with read-only files it may fail — delete `public/icon-*.png` and restart. |
| **Port already in use** | Change `PORT` in `server.js` on line 14. |
| **I get "nodeIntegration disabled" when pressing buttons** | That's expected; all communication goes through WebSockets, not Node. |

---

## Security Notes

- The pairing code is displayed only in the desktop window.
- Actions are only accepted from sockets that completed a successful `pair`.
- The code regenerates on every launch, so a new session requires a new pairing.
- The server binds to all network interfaces; if you share the LAN with others they could also try to pair (without the code they can't do anything).

---

## Dependencies

| Package   | Purpose                          |
| --------- | -------------------------------- |
| electron  | Desktop window                   |
| express   | Static web server                |
| ws        | WebSocket library                |
| qrcode    | QR code generation               |

Technologies used in the codebase: **Electron**, **Node.js**, **Express**, **ws WebSockets**, **plain JavaScript/CSS** (no CDNs).

---

## License

MIT — free to use, modify, and share.

_This project is not affiliated with, endorsed by, or sponsored by Apple Inc. or Microsoft Corporation. All product names are trademarks of their respective owners._