# UX-PLAY-1 native bridge bindings

This names the implementation of the existing UX-PLAY-1 platform commerce
contract before source integration. It does not change the exported Figma
presentation, introduce a provider, or establish an accepted native purchase.
The completed v1.12.86707 matrix predates this bridge.

## Entities and caller contract

| Entity | Exact responsibility |
| --- | --- |
| `src/services/nativeRevenueCat.ts` / `NativeBillingSession` | `{ownerUid,generation}` accompanies every native command and response; responses are checked before use. |
| `isNativeAndroid` | Tauri `isTauri` plus `native_billing_platform`; no user-agent guessing or fallback to web after an Android bridge error. |
| `configureNativeOwner`, `quoteNativeOffer`, `purchaseNativeOffer`, `getNativeCustomer`, `getNativeRocheBalance`, `logoutNativeOwner` | Existing configure/quote/purchase/customer/restore/balance/logout operations through the app-local bridge. |
| `CheckoutCustomer` | `{ownerUid,activeEntitlementIds,entitlementExpirations,purchasedProductIds}`; expiration values are epoch milliseconds or actual unlimited `null`. Web and native SDK results are projected explicitly. |
| `getCheckoutCustomer` | Passive current-customer read; native `FETCH_CURRENT`, never `restorePurchases`. |
| `restoreCheckoutCustomer` | Explicit customer Restore action; native `restorePurchases`. |
| `configuredCheckoutProductIds` | Configured web/native purchase identifiers for existing auto-offer purchase-history suppression. |
| `CheckoutOffer` | Retains existing quote fields and adds actual `productType` (`subscription` or `one_time`), `billingPeriod` (ISO 8601 or null), and `productTitle`. |
| `CheckoutPurchaseOutcome` | Provider-confirmed `purchased` with `CheckoutCustomer`, `cancelled`, or `pending`; pending requires recovery, never a second purchase invitation. |
| `src-tauri/src/native_billing.rs` / `init`, `native_billing_platform`, `native_billing` | Registers the app-local `natally-billing` plugin with the configured package and routes the seven allowlisted commands through Tauri 2.12.4. |
| `NatallyBillingPlugin`, `BillingArgs` | Android SDK ownership queue, owner/generation validation before and after callbacks, retained native Package quotes, exact provider results and no local grants. |
| `App.maybeAutoShowOfferJourney` | Passive customer projection preserves known-product and active-entitlement suppression. |
| `downloadAccess.checkDownloadAccess` | Passive customer projection preserves configured download entitlement expiry and short-lived access result. |

The client generation starts from the current epoch milliseconds and increments
on identity changes, allowing a reloaded webview to supersede prior native calls.
The native queue serializes SDK operations. Desired identity changes invalidate
old callbacks immediately; SDK login/logout follows queue ordering. Logout for an
old owner cannot log out a newer owner. Both native and client quotes expire after
two minutes and are consumed once. Actual native package references stay native.

## Configuration

All these named public values originate in `.env`, with no Natally fallback:

- `VITE_REVENUECAT_PUBLIC_KEY`, `VITE_REVENUECAT_ANDROID_PUBLIC_KEY`
- `VITE_REVENUECAT_OFFERING_ID`
- `VITE_REVENUECAT_READING_PACKAGE_ID`, `VITE_REVENUECAT_CONVERSATION_PACKAGE_ID`
- `VITE_REVENUECAT_READING_PRODUCT_ID`, `VITE_REVENUECAT_CONVERSATION_PRODUCT_ID`
- `VITE_REVENUECAT_ANDROID_READING_PRODUCT_ID`, `VITE_REVENUECAT_ANDROID_CONVERSATION_PRODUCT_ID`
- `VITE_REVENUECAT_READING_ENTITLEMENT_ID`, `VITE_REVENUECAT_DOWNLOAD_ENTITLEMENT_ID`
- `VITE_REVENUECAT_TERMS_URL`

Only bindings required by the selected operation/platform are demanded. Missing
Play products prevent a Play quote without preventing configured web checkout or
native customer/balance refresh. Product IDs and recurring terms must match the
actual catalog; this bridge does not invent monthly products or implement the
separately requested multi-pack selector.

## SDK evidence and packaging

RevenueCat Android is pinned to 11.0.0, Kotlin to 2.2.21; compileSdk 36, JVM 21 and
signing remain as already configured. Official tag sources inspected:

- [Purchases API](https://github.com/RevenueCat/purchases-android/blob/11.0.0/purchases/src/defaults/kotlin/com/revenuecat/purchases/Purchases.kt): configuration, identity, customer refresh policy, explicit restore, virtual currency invalidation/read.
- [Callback adapters](https://github.com/RevenueCat/purchases-android/blob/11.0.0/purchases/src/defaults/kotlin/com/revenuecat/purchases/listenerConversions.kt): native Kotlin callbacks.
- [StoreProduct](https://github.com/RevenueCat/purchases-android/blob/11.0.0/purchases/src/main/kotlin/com/revenuecat/purchases/models/StoreProduct.kt): actual ID, price, type and period; Google subscription IDs can include base-plan suffixes.
- [Price](https://github.com/RevenueCat/purchases-android/blob/11.0.0/purchases/src/main/kotlin/com/revenuecat/purchases/models/Price.kt): formatted price, micros and currency code.
- [CustomerInfo](https://github.com/RevenueCat/purchases-android/blob/11.0.0/purchases/src/main/kotlin/com/revenuecat/purchases/CustomerInfo.kt): purchased product IDs and entitlement dates.
- [Tauri mobile plugins](https://v2.tauri.app/develop/plugins/develop-mobile/), verified against installed 2.12.4 `src/plugin/mobile.rs`: Android registration and `run_mobile_plugin_async`.
- Installed Web SDK 1.73.1 `dist/Purchases.es.d.ts`: `productType`, `normalPeriodDuration`, price and customer projection fields.

Android MainActivity uses `singleTop`, `adjustResize`, and actual system-bar/IME
insets while retaining its current introduction animation. Source/type checks
are separate from the next prescribed full matrix and from store-distributed
purchase, pending/cancelled recovery, account switch and restored-access evidence.
