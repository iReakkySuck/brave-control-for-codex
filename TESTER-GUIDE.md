# Brave Control beta tester guide

## Requirements

- Windows 10 or 11
- A current Codex desktop installation
- Brave browser
- A separate Brave profile recommended for beta testing

## Install

1. Extract the ZIP to a normal folder. Do not run the installer from inside the ZIP preview.
2. Open PowerShell in the extracted `brave-control` folder.
3. Run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```

4. The installer prints the exact extension folder. In Brave, open `brave://extensions`, enable **Developer mode**, choose **Load unpacked**, and select that folder.
5. Pin **Brave Control for Codex** to the Brave toolbar.
6. Restart Codex and start a new task so the plugin tools load.

The installer creates a unique pairing token on the tester's computer. Never share `config.json` or `extension\pairing.json`.

## Test safely

1. Open an ordinary non-sensitive webpage.
2. Open the Brave Control popup. Leave **Keep control when this tab changes websites** selected for one approval per Brave session, or clear it for site-by-site approval.
3. Choose **Allow Codex on this tab** and review Brave's permission prompt.
4. Ask Codex to inspect or navigate the enabled Brave tab.
5. Choose **Stop Codex control** when finished.

In cross-site mode the badge reads `ALL`. The all-websites grant is removed when the last `ALL` tab is stopped or Brave restarts. Other tabs remain invisible to Codex unless separately enabled.

Opening a new tab through Codex does not enable that tab. The tester must enable it from the popup before Codex can inspect or interact with it.

Do not test on banking, payment, password-manager, healthcare, government identity, private email, or other sensitive pages. Enter passwords, one-time codes, payment details, recovery codes, and private keys yourself.

## Remove

1. Remove **Brave Control for Codex** from `brave://extensions`.
2. Uninstall **brave-control** from Codex Settings > Plugins.
3. After confirming both are removed, delete `%USERPROFILE%\plugins\brave-control` if you no longer need the local installation.

## Report problems

Report the Brave version, Codex version, Windows version, exact steps, and visible error. Do not attach private pairing files, passwords, cookies, personal browsing data, or screenshots containing sensitive information.
