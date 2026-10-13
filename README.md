# SecretNoMore

Windows account profiles with editable purchase configuration, encrypted passwords, a scheduled start, and optional automatic login/Add to Cart.

See [SETUP.md](SETUP.md) for commands. Use `-Auto` with `Prepare`, `Launch`, or `Schedule` to run the browser automation. Checkout and queue interaction remain manual.

On a new clone, run `./secret-lair.ps1 -Action Initialize` to create editable local JSON files from the public `*.example.json` templates. Existing settings are preserved. Real accounts, purchase/schedule/automation configuration, and everything under `.local/` are ignored by Git and stay on this computer. See [PUBLIC-GITHUB.md](PUBLIC-GITHUB.md) for publication and backup instructions.

The automation passed local browser tests. Its default login/cart selectors have **not been verified against the live Secret Lair site**; verify one account with `Prepare -Auto` before scheduling multiple accounts.
