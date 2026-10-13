# Publish code while keeping local configuration private

Git publishes tracked files and commit history, not every file in your folder. This project ignores these local files:

- `accounts.json`: real emails, names, shipping details, and account selection flags.
- `purchase.json`, `schedule.json`, `automation.json`: your actual purchase target, timing, account IDs, and custom controls.
- `.local/`: encrypted passwords/payment records, browser profiles/cookies, run logs, and attempt markers.

The repository instead includes sanitized `*.example.json` files. A new clone can create its own local configuration with:

```powershell
.\secret-lair.ps1 -Action Initialize
```

Existing local files are never overwritten by this command. Ignoring or removing a file from Git's index does not delete its copy from your computer. Running the application in the same checkout continues to use your saved files.

Before committing, check:

```powershell
git status --short
git diff --cached --name-only
git ls-files accounts.json purchase.json schedule.json automation.json .local
```

The last command should produce no output. `.gitignore` alone cannot protect files already tracked in an earlier commit. If any sensitive files were previously committed, remove them from history before publishing; a new commit that deletes them does not erase old commits. Rotate credentials that were already exposed publicly.

Git commits also publish their author name and email. To hide your personal email, copy your exact GitHub-provided noreply address from GitHub Settings → Emails and set it for this repository before creating new commits:

```powershell
git config --local user.email 'YOUR_EXACT_GITHUB_NOREPLY_ADDRESS'
```

The placeholder must be replaced with the address GitHub shows. This affects future commits; it does not change existing commits. Review existing identities locally with `git log --all --format='%h %an <%ae> / %cn <%ce>'` before making the repo public. Rewriting existing commit identities needs a separate deliberate step; coordinate first if commits have already been shared.

Keep a separate private backup of the four local JSON files and `.local/` if you might delete this checkout. Never upload that backup to the public repository. Windows DPAPI binds vault encryption to the Windows user/machine, so copying the vault to a different machine or Windows user may require re-entering passwords and payment details. Browser profiles contain usable sessions and must be treated as private even though the vault is encrypted.

GitHub email privacy documentation: https://docs.github.com/en/account-and-profile/how-tos/email-preferences/setting-your-commit-email-address
