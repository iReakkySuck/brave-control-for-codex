# Brave Control for Codex

Brave Control is a Windows beta that provides a local bridge between Codex and Brave. Codex can operate only tabs explicitly enabled from the extension popup, using compact viewport snapshots, screenshots, navigation, and browser-grade mouse and keyboard input.

Version 0.3.5 includes the final shared orange-and-white ChatGPT knot artwork, with the Brave toolbar icon enlarged to use the full extension icon slot. It retains the optional session-scoped mode introduced in 0.3.3, which keeps control attached to one explicitly enabled tab as it moves between normal websites. Brave asks once for all-websites permission; the extension still exposes only enabled tab IDs, and it revokes the broad permission when the last cross-site tab is stopped or Brave restarts. Compact snapshots and direct deterministic navigation remain enabled for performance.

## Beta status

This build is intended for invited testers using Brave and a current Codex desktop installation on Windows. Use a separate Brave profile for testing. Do not use the beta on password-manager, banking, payment, healthcare, government identity, or similarly sensitive pages.

The release ZIP deliberately contains no `config.json` or `extension/pairing.json`. The installer refuses packages containing those files and creates a new 256-bit pairing token and localhost port for each tester.

## Security boundaries

- The bridge listens only on a randomly selected `127.0.0.1` port.
- Each installation generates its own 256-bit token. The token is never transmitted; the extension and bridge prove possession through nonce-based HMAC challenge-response authentication.
- Generated `config.json` and `extension/pairing.json` files are excluded from Git.
- Codex receives only tabs explicitly enabled in the popup. Other tab titles and URLs are not listed.
- A tab opened through `brave_open_tab` is not automatically enabled. The user must enable that new tab from the popup before it becomes visible or controllable.
- Website access is granted one origin at a time from a user gesture. Navigating an enabled tab to a new origin changes its badge to `ASK` and blocks inspection until that site is approved.
- Alternatively, the user can explicitly choose **Keep control when this tab changes websites**. The badge shows `ALL`, and the broad host grant is used only for enabled cross-site tabs during the current Brave session.
- Controlled-tab state is session-only. Release a tab from Codex or the popup when finished.
- The extension has no cookie, history, download, password-manager, clipboard, or file-system permission.
- Sensitive-field detection, viewport filtering, and consequential-action confirmations are defense-in-depth rather than absolute guarantees. Enter passwords, recovery codes, one-time codes, payment-card data, private keys, and seed phrases yourself.
- Webpage content is treated as untrusted data. It cannot authorize new tabs, new origins, disclosure, or consequential actions.

The extension requires Chromium's `debugger` permission for CDP screenshots and genuine input events. This is a powerful permission, which is why tab enablement and site approval are enforced independently inside the extension.

## Install

For the short tester workflow, see `TESTER-GUIDE.md`.

Download or clone the repository, open PowerShell in its root, and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The installer:

1. Uses Codex's personal-plugin scaffold.
2. Copies the plugin to `%USERPROFILE%\plugins\brave-control`.
3. Generates a unique token, pairing revision, and unused loopback port.
4. Resolves Node.js on the local computer and writes the installed MCP configuration.
5. Registers and installs the personal Codex plugin when the Codex CLI is available.

The generated pairing files are private installation state. Do not upload them, paste them into issues, or commit them manually.

Restart Codex and start a new task after installation so the new MCP tools are loaded.

## Load the Brave extension

1. Open `brave://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose `%USERPROFILE%\plugins\brave-control\extension`.
5. Pin **Brave Control for Codex** to the toolbar.

## Use it

1. Open a normal HTTP(S) page or a fresh Brave New Tab.
2. Select the Brave Control toolbar icon.
3. Leave **Keep control when this tab changes websites** selected to approve once for the session, or clear it to use site-by-site approval. Then choose **Allow Codex on this tab**. On New Tab, choose **Allow Codex to navigate this tab**.
4. Ask Codex to use Brave. Only enabled tabs are visible to the plugin.
5. In site-by-site mode, approve each new site from the popup. In cross-site mode, the enabled tab continues across normal HTTP(S) websites without another approval.
6. Select **Stop Codex control** when finished.

New Tab is navigation-only because Brave blocks extensions from inspecting its internal document. Other Brave internal pages such as `brave://settings` cannot be controlled.

## Available controls

The plugin includes enabled-tab listing and selection, new/close/release tab controls, navigation history, configurable compact viewport snapshots, screenshots, element and coordinate clicks, hover, fill/type/key input, select menus, scrolling, and state waits. Opening a new tab does not grant control; the user must enable it from the popup.

## Run the included checks

From the extracted package root:

```powershell
powershell -ExecutionPolicy Bypass -File .\tests\run-tests.ps1
```

## Build a clean tester package

Maintainers can create a release ZIP with:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-release.ps1
```

The builder uses a strict allowlist and fails if it detects live pairing files, token-like secrets, absolute user-profile paths, or a computer name in the staged package.

## Updating and rotating the pairing

Re-running the installer into a clean destination creates a new pairing. For an existing development installation, replace both `config.json` and `extension/pairing.json` with matching generated values, reinstall the Codex plugin, and reload the extension. Changing only one side intentionally breaks authentication.

## Remove it

Remove **Brave Control for Codex** from `brave://extensions`, then uninstall **brave-control** from Codex Settings > Plugins. The local source folder is `%USERPROFILE%\plugins\brave-control`.

## License

MIT
