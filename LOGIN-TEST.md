# Test account login

Use `Prepare -Auto` for these tests. It attempts login only and never adds products to a cart or starts checkout. Start with one account, then test multiple accounts together. Payment and shipping information are not needed.

1. Open PowerShell 7 and switch to the project folder:

   ```powershell
   Set-Location 'C:\path\to\SecretNoMore'
   node --version
   ```

   If `node` is not found in your normal terminal, add this machine's existing bundled Node runtime to the current terminal's PATH:

   ```powershell
   $env:Path = (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin') + ';' + $env:Path
   node --version
   ```

   If you need to open the bundled PowerShell 7 from an existing terminal:

   ```powershell
   & (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe')
   ```

2. Edit `accounts.json` in a text editor. Add one object per account. Here is a minimal two-account example; replace the example emails with your Wizards Account emails. Keep any existing accounts you want to retain.

   ```json
   [
     {
       "id": "account01",
       "email": "first@example.com",
       "loginLabel": "",
       "enabled": true
     },
     {
       "id": "account02",
       "email": "second@example.com",
       "loginLabel": "",
       "enabled": true
     }
   ]
   ```

   IDs must be unique. There must be a comma between account objects, but no trailing comma after the last one. Do not put passwords in this file. Leave `loginLabel` empty initially to check for the email after login; if Secret Lair displays your account name instead, set that exact visible account name. The configured identity selector must match what the page actually displays.

3. Save each password through the hidden prompt:

   ```powershell
   .\secret-lair.ps1 -Action SetPassword -Id account01
   .\secret-lair.ps1 -Action SetPassword -Id account02
   ```

   Enter the corresponding password and press Enter for each prompt. Windows encrypts the saved values in `.local/vault.json` for your Windows user. Run the same `SetPassword` command again to replace a password. Do not manually edit the encrypted vault.

4. In `purchase.json`, change only `accountIds` to select the first account:

   ```json
   "accountIds": ["account01"]
   ```

   Keep the other existing purchase fields intact. The current tool validates the purchase configuration even in login-only mode, but `Prepare` does not buy or add that product. Scheduling does not need to be enabled for this test.

5. Validate the configuration without opening browsers:

   ```powershell
   .\secret-lair.ps1 -Action Validate -Auto
   ```

   Expect `1 enabled account(s)` and `Automation configuration valid`. This checks file structure, not whether the live site's controls match.

6. Close any browser windows previously opened by this tool for the selected profiles. Start the first login test:

   ```powershell
   .\secret-lair.ps1 -Action Prepare -Auto -Browser edge
   ```

   A separate Edge profile should open. When a login is required and the live controls match, the tool should fill the email and password and submit login. Successful identity verification produces:

   ```text
   account01: logged-in-manual
   ```

   This label means login succeeded and automation paused for your use of the window. Keep the terminal running while the browser is open. Check that the browser belongs to the expected account. Close all windows opened by this run and wait for the PowerShell prompt to return before starting another run.

7. To specifically test password entry, make sure the tool's account profile is signed out first. A saved verified session skips the password form. Sign out manually in that isolated profile, close its windows, wait for the run to finish, then repeat `Prepare -Auto`. Do not delete profiles just to test password entry.

8. After the first account works, select both accounts in `purchase.json`:

   ```json
   "accountIds": ["account01", "account02"]
   ```

   Run the same validation and login commands:

   ```powershell
   .\secret-lair.ps1 -Action Validate -Auto
   .\secret-lair.ps1 -Action Prepare -Auto -Browser edge
   ```

   Expect two separate browser profiles and one `logged-in-manual` status per account. Verify each window's account identity. Add more account objects, save each password, and include their IDs in `accountIds` to expand the test.

If a test pauses or fails:

- `manual-intervention`: inspect the browser. A CAPTCHA, verification code, first-time account connection, incorrect visible identity label, or mismatched selector may need manual handling. Complete any required verification yourself, close the run's windows, and rerun the test. The tool does not automatically resume a flow that has already paused.
- `controls-or-login-not-confirmed`: expected controls or the signed-in identity were not found within the timeout. The default selectors in `automation.json` have not been verified against the live Secret Lair site. Check the actual controls and `loginLabel`; do not assume this means the password is incorrect.
- `ambiguous-controls`: more than one visible element matched. The relevant selector needs to be made more specific.
- `launch-failed`: check that Edge is installed and that another browser process is not using the same tool profile. For Chrome, use `-Browser chrome` consistently; it has separate profiles.
- Missing saved password: rerun `SetPassword` for the ID named in the error.
- Another run/lock message: close the previous automation run normally. If it crashed, check the PID recorded in `.local/automation.lock`; remove the lock only after confirming that process has ended.

To inspect the latest status from a second PowerShell window:

```powershell
Set-Location 'C:\path\to\SecretNoMore'
(Get-Content .\.local\last-run.json -Raw | ConvertFrom-Json).accounts |
    Format-Table id, status, reason
```

For troubleshooting, provide the status/reason and what screen remained open, with personal details redacted. Never share passwords or the vault.
