# Security policy

## Beta warning

Brave Control is beta software with powerful browser automation permissions. Test it in a separate Brave profile and keep it away from passwords, one-time codes, recovery material, payment data, private keys, and other sensitive workflows.

## Security model

- The bridge listens only on `127.0.0.1` and uses a randomly selected local port.
- Each installation generates a private 256-bit pairing token.
- The token is not sent over the socket; both sides prove possession using nonce-based HMAC-SHA-256 challenge-response authentication.
- Only tabs explicitly enabled from the extension popup can be listed or controlled.
- HTTP(S) origins require a permission grant from the popup. Users may choose exact-site approval or an all-websites grant scoped by extension logic to selected tabs for the current Brave session.
- New tabs opened by Codex are not automatically enabled.
- Tab enablement is stored only for the current browser session.
- Session-scoped all-websites permission is removed when the last cross-site tab is stopped and on Brave startup.
- Webpage content is untrusted and cannot grant new permissions or authorize consequential actions.

The pairing token is stored locally because both the Brave extension and Codex bridge must read it. Compromise of the tester's operating-system account, Brave profile, Codex installation, or another process running with equivalent local privileges is outside this threat model.

## Reporting a vulnerability

Use a private GitHub security advisory for the repository when available. Do not open a public issue containing a pairing token, browser data, screenshots, logs with private URLs, or reproduction material containing personal information.

Include the affected version, operating-system version, Brave version, Codex version, reproduction steps, and expected security boundary. Rotate the pairing by reinstalling before sharing diagnostic files.

## Supported beta version

Only the latest beta package is supported. Security fixes may require reinstalling the Codex plugin and reloading the unpacked Brave extension.
