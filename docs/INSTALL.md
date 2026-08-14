# Installing Misal

Misal runs entirely on your own machine. There is no account to create, no server to sign in to,
and nothing is uploaded anywhere.

Two ways to get it: **download a build**, or **build it yourself**.

---

## Option 1 — download a build

Go to [Releases](https://github.com/srivathsanvenkateswaran/Misal/releases) and download the file
for your system:

| System | File |
|---|---|
| macOS (Apple Silicon) | `Misal_<version>_aarch64.dmg` |
| macOS (Intel) | `Misal_<version>_x64.dmg` |
| Windows | `Misal_<version>_x64-setup.exe` |
| Linux | `misal_<version>_amd64.AppImage` or `.deb` |

### The builds are unsigned, and your system will say so

Code signing certificates cost money annually — Apple charges $99/year, and Windows code signing
is comparable. Misal is a free personal project and has neither. Your operating system cannot tell
"unsigned" from "malicious", so it warns you the same way for both.

Here is what you will see and what to do. **You should be suspicious of any download that tells you
to bypass a security warning** — the reason to trust this one is that you can read every line of
what it does, and build it yourself from Option 2 if you would rather not take anyone's word.

**macOS.** Double-clicking gives you *"Misal is damaged and can't be opened"* or *"cannot be opened
because the developer cannot be verified"*. Neither is true; both mean unsigned. Either:

- Right-click the app → **Open** → **Open** in the dialog. Once per install.
- Or, if that does not appear, remove the quarantine flag macOS adds to downloads:
  ```
  xattr -dr com.apple.quarantine /Applications/Misal.app
  ```

**Windows.** SmartScreen shows *"Windows protected your PC"*. Click **More info** → **Run anyway**.

**Linux.** Make the AppImage executable: `chmod +x misal_*.AppImage`, then run it. For the `.deb`,
`sudo dpkg -i misal_*.deb`.

---

## Option 2 — build it yourself

Slower, but you are running exactly the code you read.

### What you need

| Tool | Version | Where |
|---|---|---|
| Node.js | 22 or newer | https://nodejs.org |
| pnpm | 9 or newer | `npm install -g pnpm` |
| Rust | 1.77 or newer | https://rustup.rs |

Plus a platform toolchain:

- **macOS** — `xcode-select --install`
- **Windows** — [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
  with "Desktop development with C++", and [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/)
  (already present on Windows 11)
- **Linux (Debian/Ubuntu)** —
  ```
  sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libgtk-3-dev
  ```

### Build

```bash
git clone https://github.com/srivathsanvenkateswaran/Misal.git
cd Misal
pnpm install
pnpm tauri build
```

The first build compiles the whole Rust dependency tree and takes several minutes. Later builds
take seconds.

The result lands in `src-tauri/target/release/bundle/`.

To run it in development instead, with live reload:

```bash
pnpm tauri dev
```

---

## The first time you open it

**Your system will ask for your password once.** This is the operating system's keychain, not
Misal.

Misal encrypts its database, and the key to that database is stored in your OS keychain — macOS
Keychain, Windows Credential Manager, or your Linux keyring. That is why the key is never in a file
anyone could copy. The first time Misal asks the keychain for it, your system asks you to approve
the request, exactly as it would for any application reading a stored password.

Choose **Always Allow** and you will not be asked again.

If you deny it, Misal will tell you what it needed and offer to try again. It will not start
without it, because without that key the database cannot be read.

> **A note for anyone building from source repeatedly:** every time you rebuild, you produce a new
> unsigned binary, and macOS treats each one as a different application asking for the same stored
> password. So the prompt returns after each build. This does not happen with a downloaded release,
> which stays one application.

### On Linux without a keyring

If your system has no keyring daemon running — common on minimal window managers — Misal will offer
a passphrase instead. That passphrase becomes the key to your database. **There is no recovery if
you forget it.** Nothing anywhere can decrypt the file without it.

---

## Where your data lives

| System | Location |
|---|---|
| macOS | `~/Library/Application Support/dev.misal.Misal/` |
| Windows | `%APPDATA%\misal\Misal\data\` |
| Linux | `~/.local/share/misal/` (or `$XDG_DATA_HOME/misal/`) |

One file, `misal.db`, encrypted. Back it up like any other file — but **the backup is useless
without the keychain entry**, so if you are moving to a new machine, copy both or export your data
first (Settings → Export).

Misal writes nowhere else, and reads nothing you did not hand it.

---

## Uninstalling

Delete the application, then delete the data directory above. On macOS you can also remove the
keychain entry: Keychain Access → search `dev.misal.app` → delete.
