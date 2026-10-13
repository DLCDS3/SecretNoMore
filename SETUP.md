# Secret Lair account setup

This system manages account configuration, encrypted secrets, purchase targets, and separate persistent browser profiles on Windows. Add `-Auto` to automatically log in and attempt Add to Cart, followed by View Cart when configured. It never fills payment fields, proceeds to checkout, or submits an order. If Add to Cart redirects away from the product page, it leaves that destination alone for manual handling.

The current configuration uses `"loginOrder": "cart-first"`. Full runs open the configured product first, attempt Add to Cart once, click View Cart or Proceed to Cart, then enter saved credentials if that navigation presents login. A View Cart popover can be followed by one Proceed to Cart click. The worker does not bypass queues or submit an order. `cart-login-completed-manual` means the cart-triggered login was verified and automation stopped. Use `"loginOrder": "login-first"` to restore the original order. `Prepare -Auto` remains login-only in either mode.

The cart's **LOG IN / SIGN UP** prompt is recognized even when the product URL does not change. The worker prioritizes this prompt over the background header's Sign In control, fills credentials on an allowed login origin, and waits for the configured account identity before marking login complete. A verification challenge still needs manual handling.

Cart login controls are searched in approved-origin frames as well as the main page. Role-based label matches handle icons and split text, with a text fallback. If lookup fails, `cart-login-diagnostic` lines show frame origins and relevant visible button labels; they omit URL query strings and input values. An unknown frame origin is diagnosed but is not automatically trusted for clicking or credential entry.

Credential fields prioritize approved login-provider pages/frames over the storefront, to avoid selecting a newsletter email box while an authentication popup loads. Email address/Password label fallbacks support nonstandard field attributes. `waiting-for-email-field` means the form is still being located; `entering-email` means a field has been selected for filling. On failure, `login-field-diagnostic` reports origin and input type/id/name/autocomplete metadata without values, passwords, or URL query strings. The last-run status is updated as each stage progresses.

If an item was already added by a previous run, close that run's browser windows and let its worker exit, then use `./secret-lair.ps1 -Action ResumeCart -Auto -Browser edge`. This reopens the selected profiles, opens their existing cart, proceeds to the cart login prompt, and attempts login. It does not click Add to Cart, change quantity, clear attempt markers, or submit checkout. Keep `loginOrder` set to `cart-first` and select only the accounts whose carts you want to resume.

**Live-site verification is still required.** Browser inspection was unavailable during development, so `automation.json` contains editable starting selectors rather than verified site selectors. The login/cart flow passed tests against local fixture pages. A first-time Wizards/Secret Lair connection, verification challenge, or page that does not match these selectors requires manual handling. Use automated access only within the site's applicable rules.

For a new clone, first run `./secret-lair.ps1 -Action Initialize`. It copies public `*.example.json` templates only for local configuration files that do not already exist. Your real JSON files and `.local/` are excluded from Git. Editing public example files makes those edits publishable; put personal settings in the real local files instead.

## Editable files

- `accounts.json`: copy the sample account object to add accounts. Give each a unique ID and email; set `enabled` to `true` when ready. `loginLabel` is the exact visible identity text expected after login; leave it empty to use the email. If the site displays your account name instead, set that name and adjust `signedInIdentity` in `automation.json` as necessary. Remove the object to remove an account from the launcher. Shipping details are plain text, so this file is excluded from Git.
- `purchase.json`: set the exact product URL, matching product ID, full visible product title, variant (`Foil` or `Non-foil`), quantity, total cap, and account IDs. Automation checks the URL, title, variant, and quantity before clicking. The total cap is reserved for a future checkout adapter; it is not checked against shipping/tax because checkout is manual. If quantity controls are absent, only quantity 1 is supported, assuming the site's default single-item add.
- `automation.json`: editable login/cart controls and allowed login origins. The script sends credentials only to the store or listed login origins. If Wizards changes its sign-in provider, verify the new origin before adding it. Multiple matching visible controls cause a manual pause rather than choosing the first.
- `.local/vault.json`: encrypted secrets; manage through the script rather than editing ciphertext. Passwords and card details use Windows DPAPI, tied to the current Windows user. This is protection for stored files, not against programs running as that user. Do not share or commit browser profiles or the vault.

`automation.json` now uses `"postCartAction": "view-cart"`: after one Add to Cart attempt, it clicks a unique visible View Cart control while still on the same product page, then stops. Use `"postCartAction": "stop"` to stop immediately after Add to Cart. An automatic redirect is left alone; no forced cart navigation is used. `view-cart-attempted-manual` records the follow-up click. `cart-followup-needed-manual` means Add to Cart was attempted but the View Cart step needs manual review. These states do not confirm queue entry.

Foil example: product ID `1252788`, URL ending in `secret-lair-x-marvel-true-believers-in-love-foil-edition`, expected variant `Foil`.

Non-foil example: product ID `1252789`, URL ending in `secret-lair-x-marvel-true-believers-in-love`, expected variant `Non-foil`.

## Commands

Run from PowerShell in this folder:

```powershell
.\secret-lair.ps1 -Action Validate
.\secret-lair.ps1 -Action SetPassword -Id account01
.\secret-lair.ps1 -Action SetPayment -Id primary
.\secret-lair.ps1 -Action Launch -Browser edge
.\secret-lair.ps1 -Action Prepare -Browser edge
.\secret-lair.ps1 -Action Schedule -Browser edge -DryRun
.\secret-lair.ps1 -Action Schedule -Browser edge
.\secret-lair.ps1 -Action ConfirmQueue -Id account01
.\secret-lair.ps1 -Action Prepare -Auto -Browser edge
.\secret-lair.ps1 -Action Launch -Auto -Browser edge
.\secret-lair.ps1 -Action Schedule -Auto -Browser edge -DryRun
.\secret-lair.ps1 -Action Schedule -Auto -Browser edge
.\secret-lair.ps1 -Action ResetCartAttempt -Id account01
.\secret-lair.ps1 -Action RemovePassword -Id account01
.\secret-lair.ps1 -Action RemovePayment -Id primary
```

Secrets are entered interactively, keeping them out of command history. CVV is not saved. `paymentId` connects an account to a named payment record for a future adapter; no payment information is sent to a website by this starter.

The launcher opens one visible browser profile per enabled selected account. Without `-Auto`, all website actions are manual. With `-Auto`, it reads each saved password, fills the login fields when needed, verifies the visible account identity, and attempts Add to Cart once for the specified item. An already verified session can skip password entry. Payment records remain unused. Passwords pass to the Node worker through a private stdin pipe, not command arguments or plaintext files. Raw browser errors, traces, and screenshots are not saved because they can expose entered values.

Automatic mode requires Node.js and Playwright. The PowerShell script first looks for Node on PATH and then automatically checks this user's bundled Codex runtime, so this machine does not need a PATH change for `-Auto`. For another environment without the bundle, install Node.js and run `npm install` from this folder. The worker uses installed Edge or Chrome; no separate browser download is needed. Close windows opened by earlier runs of the same account profiles before starting `-Auto`; persistent profiles cannot be opened by two browser processes at once.

Test one account with `Prepare -Auto` first. It logs in without adding anything. If the log reports `manual-intervention`, check the visible window, complete any account connection or verification manually, and update the relevant selector or account label before trying again. Do not treat a configuration dry run as live-site verification.

Deleting an account from JSON does not erase its saved vault entry or browser profile. Use `RemovePassword` for its vault entry; close its browser and delete the matching `.local/profiles/<browser>/<account-id>` directory if you also want to erase local sessions.

## Scheduled start and manual queue checkpoint

Edit `schedule.json` to set the start date/time, then set `enabled` to `true`. The sample is **October 5, 2026 at noon New York time**, which is EDT, UTC-04:00. The Windows time zone ID `Eastern Standard Time` includes seasonal daylight-saving changes; it does not mean a fixed UTC-05:00 offset. The script rejects nonexistent or ambiguous times around clock changes.

Run `Prepare -Auto` ahead of the sale to verify login without adding a product, then close those browser windows. Run `Schedule -Auto` to pre-open the selected profiles and wait for the target time. At that time, all ready account flows start concurrently: verify session/login, open the exact product, and attempt Add to Cart once. Login and network response time still vary, so verifying saved sessions ahead of time improves readiness. Edits made after arming require cancelling and starting again. Without `-Auto`, the original scheduled URL launcher is still available.

The schedule must remain running on an awake machine with accurate system time. It is not a Windows scheduled task and does not start after a reboot. Late starts caused by sleep or hibernation are rejected if they exceed `maxLatenessSeconds`. Neither browser action time nor server processing can be guaranteed simultaneous.

The script records account statuses in `.local/last-run.json`. Automatic mode stays running while the browser windows remain open. `cart-attempted-manual` means the click was sent; it does not confirm an item reservation or queue entry. `cart-outcome-unknown-manual` means the click might have been sent but its result is uncertain. Neither status triggers retries, reloads, or checkout. The website may transition itself while you wait. Published Wizards instructions for the example drop say entering the pre-queue requires adding a product **and proceeding to checkout**, so Add to Cart alone may leave you outside the queue. Take that next step manually if needed. Source: https://magic.wizards.com/en/news/announcements/secret-lair-a-perfectly-normal-superdrop

Use `ConfirmQueue -Id <account-id>` in a second PowerShell window to record that you manually checked the paused window. This is a local status update only and does not resume automation. Confirmation refers to the most recent launch. Close all automatic browser windows to finish the worker. Keep the PowerShell/Node process running while using those windows; forcibly ending it may close its browsers. Ctrl+C before dispatch cancels the schedule; after dispatch the worker stops further automated steps and leaves browser windows for manual use where its signal handler can run.

Before sending a cart click, the worker saves an attempt marker in `.local/cart-attempts`. Later runs for that account/product stop before navigating if the marker exists, protecting against duplicate additions after an uncertain result. After checking the actual cart and closing the active run, use `ResetCartAttempt -Id <account-id>` to allow another attempt for the product currently configured in `purchase.json`. Resetting does not remove the item from the website's cart. A forced process crash may leave `.local/automation.lock`; confirm its recorded process is no longer running before removing that file manually.

`Schedule -DryRun` validates and displays the resolved start without waiting or opening windows. Dry runs are allowed with disabled schedules and accounts; real launches require enabled selected accounts.

Validation commands:

```powershell
node --test tests/automation.test.mjs
.\tests\scheduler.tests.ps1
.\tests\auto-launch.tests.ps1
```

The Node tests launch headless Edge against local fixture pages and check login, identity/origin/product checks, concurrent sessions, one cart click, and queue handoff. The PowerShell tests use temporary files and mock browser/worker launches, checking scheduling and encrypted password transfer with synthetic credentials. No test contacts Secret Lair or submits real credentials.
