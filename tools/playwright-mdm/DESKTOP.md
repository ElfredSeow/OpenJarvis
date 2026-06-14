# Jarvis Hub as a desktop app

Two options, lightest first.

## 1. Edge app window (works today, no build)

`Start Jarvis.bat` launches the Hub in an Edge **app window** — no tabs, no
address bar, its own taskbar entry. It looks and feels like a native app:

```bat
start "" msedge --app=http://localhost:4100
```

This is the recommended setup. To pin it: right-click the window's taskbar icon
→ Pin. You can also make a desktop shortcut to `Start Jarvis.bat`.

## 2. Tauri wrapper (true native app — requires the Rust toolchain)

The repo already ships a Tauri app under `desktop/`. A dedicated Hub window can
be added by pointing a Tauri window at the local server. This is **not built
yet** because it needs the Rust toolchain (`rustup` + `cargo`) and a build step
that can't be verified here. Sketch of the minimal config:

```jsonc
// src-tauri/tauri.conf.json (Tauri v2)
{
  "app": {
    "windows": [
      { "title": "Open Jarvis", "width": 1200, "height": 800,
        "url": "http://localhost:4100" }
    ]
  }
}
```

The Tauri shell would also need to start `node jarvis-ui.js` as a sidecar (or
expect it already running). When you want this, install Rust first:

```powershell
winget install Rustlang.Rustup
```

…and I'll wire the sidecar + window. Until then, option 1 gives you the desktop
experience with zero extra tooling.
