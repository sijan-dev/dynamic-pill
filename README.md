# Dynamic Pill — Fedora GNOME Shell

Apple Dynamic Island inspired pill for GNOME Shell 50+ (Fedora Workstation 44+), built natively with GJS / St / Clutter.

Inspired by [DynamicGlacier (Hyprland/Quickshell)](https://github.com/mavxa/DynamicGlacier) but implemented as a **native GNOME Shell extension** using Wayland-safe Shell actors.

![GNOME 50+](https://img.shields.io/badge/GNOME-50%2B-blue) ![Fedora 44](https://img.shields.io/badge/Fedora-44-51a2da) ![Wayland](https://img.shields.io/badge/Wayland-compatible-success)

---

## What it does

- **Idle pill** — minimal centered clock (e.g. `18:42`) that barely consumes space
- **Expands smoothly** for system events with 150–350ms Clutter animations (width/opacity/scale)
- **Auto-collapses** back to idle after a configurable timeout
- Priority queue prevents random overwriting of important states

```
                 ╭────────────────╮
                 │     18:42      │
                 ╰────────────────╯
                         ↓ event
              ╭────────────────────────────╮
              │ 🔊  Volume  ████████░░ 72% │
              ╰────────────────────────────╯
                         ↓ timeout
                 ╭────────────────╮
                 │     18:43      │
                 ╰────────────────╯
```

### Supported events

| Event | Source | View |
|---|---|---|
| **Media (MPRIS)** | `org.mpris.MediaPlayer2` via D-Bus | Track, artist, art placeholder, prev/play/next |
| **Volume** | `Gvc.MixerControl` / Shell OSD fallback | Level bar + mute |
| **Brightness** | `org.gnome.SettingsDaemon.Power.Screen` + OSD | Level bar |
| **Workspace** | `global.workspace_manager` | `Workspace 3` |
| **Battery** | `org.freedesktop.UPower` DisplayDevice | Charging / low |
| **Notifications** | `Main.messageTray` | App + summary |
| **Network** | `org.freedesktop.NetworkManager` | Connected / offline |
| **Bluetooth** | `org.bluez` Device1 | Connected / disconnected |
| **Privacy** | Panel `_privacyIndicator` + `org.gnome.Mutter.ScreenCast` | Mic / Screen sharing |

All modules are **event-driven** (no polling loops), isolated, and fail gracefully if the underlying service is unavailable.

---

## Requirements

- Fedora Workstation 44 (or any distro with **GNOME Shell 50+**)
- Wayland or X11 (Wayland tested)
- No external runtimes — no Node, Python, Rust, Qt

Check yours:

```bash
cat /etc/os-release
gnome-shell --version   # → 50.x
echo $XDG_SESSION_TYPE  # → wayland
```

---

## Installation

```bash
git clone <repo> gnome-dynamic-pill
cd gnome-dynamic-pill
./scripts/install.sh
```

This copies the extension to `~/.local/share/gnome-shell/extensions/dynamic-pill@fedora-gnome.io/` and compiles the GSettings schema.

Then enable:

```bash
gnome-extensions enable dynamic-pill@fedora-gnome.io
# Wayland: logout/login (or Alt+F2 → 'r' on X11)
gnome-extensions info dynamic-pill@fedora-gnome.io
```

Disable / uninstall:

```bash
gnome-extensions disable dynamic-pill@fedora-gnome.io
./scripts/uninstall.sh
```

**Packaged install (zip):**

```bash
gnome-extensions pack --extra-source=src --extra-source=schemas
gnome-extensions install dynamic-pill@fedora-gnome.io.shell-extension.zip
```

---

## Preferences

Open with:

```bash
gnome-extensions prefs dynamic-pill@fedora-gnome.io
# or GNOME Extensions app
```

**General**
- Enable pill, idle clock, position (`top-center` / `below-panel` / `panel-integrated`), vertical offset, monitor mode, time format (`%H:%M`)

**Appearance**
- Opacity, animation speed, compact mode, shadow

**Events**
- Toggle each module: Media, Volume, Brightness, Battery, Workspace, Notifications, Network, Bluetooth, Privacy

**Behavior**
- Hover expand, auto-collapse, collapse timeout, notification timeout

---

## Testing / Debug

The extension exposes a debug handle in Looking Glass:

1. `Alt+F2` → type `lg` → Enter
2. In evaluator:

```js
global.dynamicPillState.test("volume")
global.dynamicPillState.test("brightness")
global.dynamicPillState.test("media")
global.dynamicPillState.test("battery")
global.dynamicPillState.test("workspace")
global.dynamicPillState.test("notification")
global.dynamicPillState.test("network")
global.dynamicPillState.test("bluetooth")
global.dynamicPillState.test("privacy")
global.dynamicPillState.test("idle")
```

Logs:

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep DynamicPill
```

---

## Architecture

```
gnome-dynamic-pill/
├── metadata.json
├── extension.js            # Extension lifecycle (enable/disable)
├── prefs.js                # Adw/GTK4 preferences (ExtensionPreferences)
├── stylesheet.css          # Pill theming, 999px radius, shadows
├── schemas/*.gschema.xml   # GSettings
├── src/
│   ├── state.js            # Priority queue + timeout state machine
│   ├── pill.js             # Top-center actor, Clutter animations, views
│   ├── animations.js       # Reusable ease helpers
│   ├── eventManager.js     # Wires modules to StateManager
│   └── modules/
│       ├── media.js        # MPRIS D-Bus watcher
│       ├── volume.js       # Gvc + OSD fallback
│       ├── brightness.js   # SettingsDaemon + OSD
│       ├── workspace.js    # workspace_manager signal
│       ├── battery.js      # UPower
│       ├── notifications.js# messageTray hook
│       ├── network.js      # NetworkManager
│       ├── bluetooth.js    # BlueZ
│       └── privacy.js      # privacy indicator + ScreenCast
└── scripts/
    ├── install.sh
    └── uninstall.sh
```

**State machine:**

```
IDLE ──priority─→ EXPANDED ──timeout──→ next queue or IDLE
```

**Performance:** idle CPU ~0, no polling, all signals disconnected on `disable()`, actors destroyed, no leaked timeouts.

---

## Known Limitations (v1)

- Album art is placeholder (icon) — full texture caching for `mpris:artUrl` needs async image loading (next iteration)
- Network/Bluetooth are opt-in (disabled by default) — they show only coarse connect/disconnect, not per-SSID details
- Privacy detection relies on Shell's private `_privacyIndicator` — may need adaptation if GNOME internals change
- Multi-monitor `all` mode currently maps to `primary` — per-monitor pills need additional chrome actors (documented, opt-in)
- Volume via `Gvc` requires `Gvc-1.0` gir — fallback to OSD works but level precision is slightly coarser

If any module fails, it logs `* unavailable` and the rest of the pill keeps working.

---

## GNOME Compatibility

Targets **GNOME Shell 50** (Fedora 44). Uses the modern `Extension` (`resource:///org/gnome/shell/extensions/extension.js`) and `ExtensionPreferences` APIs introduced in GNOME 45+. No legacy `imports` boilerplate.

Adding older Shell support would require conditional `imports` vs `import` shims — structure is ready for it but not included to keep v1 clean.

---

## License

GPL-3.0-or-later — same as most GNOME Shell extensions.

---

## Roadmap

- [ ] Real album art texture cache via `St.TextureCache` / `Clutter.Image`
- [ ] Per-monitor pill actors for `monitor-mode = all`
- [ ] OSD interception to optionally hide duplicate system OSD when pill handles volume/brightness
- [ ] Accessibility: keyboard focus traversal for media controls

Contributions welcome. Keep it lightweight and event-driven.
