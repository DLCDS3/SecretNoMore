# Schedule login, Add to Cart, and View Cart

1. In `accounts.json`, set `enabled` to `true` for the accounts you want. Each must already have a saved password. In `purchase.json`, include those IDs in `accountIds` and configure the exact product URL, ID, full visible title, variant, and quantity. Keep `checkoutMode` set to `review`.

2. In `automation.json`, use `"postCartAction": "view-cart"` (the current default). The `viewCart` selectors match buttons or links labeled exactly View Cart. The live site may require different selectors; these defaults have only been tested against local fixture pages.

3. Set a future New York date/time in `schedule.json` and enable it. Example only:

   ```json
   {
     "enabled": true,
     "startLocal": "2026-10-13T12:00:00",
     "timeZoneId": "Eastern Standard Time",
     "maxLatenessSeconds": 30
   }
   ```

   Replace the example with your intended date and time. `Eastern Standard Time` is the Windows time zone identifier and follows daylight saving time; October 13 at noon is EDT, UTC-04:00. The old October 5 example is in the past and cannot be armed.

4. From PowerShell in the project folder, validate without opening browsers or arming the event:

   ```powershell
   .\secret-lair.ps1 -Action Schedule -Auto -Browser edge -DryRun
   ```

5. Close existing tool-created profile windows, then arm the actual run:

   ```powershell
   .\secret-lair.ps1 -Action Schedule -Auto -Browser edge
   ```

   Browser windows open ahead of time. Keep PowerShell running and the computer awake. At the target time, each ready account flow starts concurrently. With the current `loginOrder: cart-first`, it opens the product, attempts Add to Cart once, clicks View Cart/Proceed to Cart when available, and enters saved credentials if prompted. With `loginOrder: login-first`, login happens before opening the product. Both modes stop for manual handling and never submit an order. Network/login latency means cart clicks will not necessarily happen at the same instant.

If Add to Cart redirects to a queue, cart, or any other destination, the worker leaves that page alone. It never proceeds to checkout or clicks through the queue. Missing or ambiguous View Cart controls cause a manual pause without another cart addition. Close all automatic browser windows when finished so the worker can end normally.

To test the full sequence immediately instead of scheduling:

```powershell
.\secret-lair.ps1 -Action Launch -Auto -Browser edge
```

That command really attempts to add the configured item. Before repeating a cart test, check the existing cart and close the previous run. If the duplicate-attempt protection blocks it, use `ResetCartAttempt -Id <account-id>` for the currently configured product only after reviewing the first attempt.

For an existing cart, prefer `./secret-lair.ps1 -Action ResumeCart -Auto -Browser edge` after closing the previous run. It resumes the cart-to-login sequence without another addition or an attempt-marker reset, including the LOG IN / SIGN UP prompt on the same product URL.
