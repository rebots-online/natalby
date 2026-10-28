import { Purchases, PurchasesError, ErrorCode } from '@revenuecat/purchases-js';
import type { CustomerInfo, Package, PurchaseResult } from '@revenuecat/purchases-js';
import { auth } from './firebase';
import type { PurchaseKind } from './purchaseIntent';
import {
  isNativeAndroid, configureNativeOwner, quoteNativeOffer, purchaseNativeOffer,
  getNativeCustomer, getNativeRocheBalance, logoutNativeOwner,
} from './nativeRevenueCat';
import type { NativeBillingSession } from './nativeRevenueCat';
// UX-PLAY-1: every billing binding is an explicit import.meta.env public value,
// required only when the matching platform/purchase path runs; nothing is
// defaulted and nothing is required at module load.
const QUOTE_TTL_MS = 2 * 60 * 1000;
function envValue(name: string): string | null {
  const raw = (import.meta.env as unknown as Record<string, string | undefined>)[name];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}
function requireEnv(name: string): string {
  const value = envValue(name);
  if (value === null) throw new Error(`Required billing binding ${name} is not configured; refusing to continue.`);
  return value;
}
function publicKeyFor(native: boolean): string {
  const key = requireEnv(native ? 'VITE_REVENUECAT_ANDROID_PUBLIC_KEY' : 'VITE_REVENUECAT_PUBLIC_KEY');
  const prefix = native ? 'goog_' : 'rcb_';
  if (!key.startsWith(prefix)) {
    throw new Error(`The configured ${native ? 'Android' : 'web'} public SDK key must start with "${prefix}"; refusing to use it.`);
  }
  return key;
}
const webPublicKey = (): string => publicKeyFor(false);
const androidPublicKey = (): string => publicKeyFor(true);
const offeringIdentifier = (): string => requireEnv('VITE_REVENUECAT_OFFERING_ID');
const termsUrl = (): string => requireEnv('VITE_REVENUECAT_TERMS_URL');
type PlatformMapping = { packageIdentifier: string; productIdentifier: string };
function mappingFromEnv(packageEnv: string, productEnv: string): PlatformMapping | null {
  const packageIdentifier = envValue(packageEnv);
  const productIdentifier = envValue(productEnv);
  return packageIdentifier !== null && productIdentifier !== null ? { packageIdentifier, productIdentifier } : null;
}
// Android quotes reuse the shared package identifiers with store-specific products.
function androidMapping(kind: PurchaseKind): PlatformMapping | null {
  return kind === 'reading'
    ? mappingFromEnv('VITE_REVENUECAT_READING_PACKAGE_ID', 'VITE_REVENUECAT_ANDROID_READING_PRODUCT_ID')
    : mappingFromEnv('VITE_REVENUECAT_CONVERSATION_PACKAGE_ID', 'VITE_REVENUECAT_ANDROID_CONVERSATION_PRODUCT_ID');
}
function webMapping(kind: PurchaseKind): PlatformMapping | null {
  return kind === 'reading'
    ? mappingFromEnv('VITE_REVENUECAT_READING_PACKAGE_ID', 'VITE_REVENUECAT_READING_PRODUCT_ID')
    : mappingFromEnv('VITE_REVENUECAT_CONVERSATION_PACKAGE_ID', 'VITE_REVENUECAT_CONVERSATION_PRODUCT_ID');
}
function requiredMapping(kind: PurchaseKind, platform: 'web' | 'android'): PlatformMapping {
  const mapping = platform === 'android' ? androidMapping(kind) : webMapping(kind);
  if (!mapping) throw new Error(`The ${platform} product bindings for "${kind}" are not configured; refusing to guess them.`);
  return mapping;
}
export function configuredCheckoutProductIds(): string[] {
  const names = ['VITE_REVENUECAT_READING_PRODUCT_ID', 'VITE_REVENUECAT_CONVERSATION_PRODUCT_ID',
    'VITE_REVENUECAT_ANDROID_READING_PRODUCT_ID', 'VITE_REVENUECAT_ANDROID_CONVERSATION_PRODUCT_ID'];
  return [...new Set(names.map(envValue).filter((value): value is string => value !== null))];
}
export type CheckoutOffer = {
  readonly kind: PurchaseKind; readonly ownerUid: string; readonly quoteId: string;
  readonly packageIdentifier: string; readonly productIdentifier: string;
  readonly formattedPrice: string; readonly amountMicros: number; readonly currency: string; readonly expiresAt: number;
  readonly productType: 'subscription' | 'one_time'; readonly billingPeriod: string | null; readonly productTitle: string;
};
export type CheckoutCustomer = {
  ownerUid: string;
  activeEntitlementIds: string[];
  entitlementExpirations: Record<string, number | null>;
  purchasedProductIds: string[];
};
export type CheckoutPurchaseOutcome =
  | { state: 'purchased'; customerInfo: CheckoutCustomer }
  | { state: 'cancelled' }
  | { state: 'pending' };
type CachedQuote = CheckoutOffer & {
  platform: 'web' | 'native'; sessionGeneration: number; rcPackage?: Package; offer: CheckoutOffer;
};
class CheckoutError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'CheckoutError';
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}
const quoteCache = new Map<string, CachedQuote>();
let operationsTail: Promise<unknown> = Promise.resolve();
let purchaseInFlight = false;
let authGeneration = 0;
let authListenerInstalled = false;
let lastSeenUid: string | null = null;
let lastSeenUidInitialized = false;
// UX-PLAY-1: native session generation is seeded from the wall clock so it
// survives webview reloads while the Android plugin process stays alive, and
// is incremented on every identity change afterwards.
let nativeGeneration = Date.now();
let nativeConfigured: NativeBillingSession | null = null;
function installAuthListener(): void {
  if (authListenerInstalled) return;
  authListenerInstalled = true;
  auth.onAuthStateChanged((user) => {
    const uid = user?.uid ?? null;
    if (!lastSeenUidInitialized) { lastSeenUidInitialized = true; lastSeenUid = uid; return; }
    if (uid === lastSeenUid) return;
    lastSeenUid = uid;
    authGeneration += 1;
    nativeGeneration = nativeGeneration >= Number.MAX_SAFE_INTEGER ? Date.now() : nativeGeneration + 1;
    quoteCache.clear();
    const staleSession = nativeConfigured;
    nativeConfigured = null;
    if (staleSession) logoutNativeOwner(staleSession).catch(() => undefined);
  });
}
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const run = operationsTail.then(operation, operation);
  operationsTail = run.then(() => undefined, () => undefined);
  return run;
}
function assertGeneration(entryGeneration: number): void {
  if (authGeneration !== entryGeneration) throw new CheckoutError('The signed-in account changed during checkout; please retry.');
}
function currentUid(): string {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new CheckoutError('A signed-in account is required for checkout; anonymous checkout is not supported.');
  return uid;
}
function validateKind(kind: unknown): PurchaseKind {
  if (kind !== 'reading' && kind !== 'conversation') throw new CheckoutError(`Unknown purchase kind "${String(kind)}"; refusing to build a checkout offer.`);
  return kind;
}
async function ensureSdkForOwner(uid: string): Promise<Purchases> {
  if (!Purchases.isConfigured()) return Purchases.configure({ apiKey: webPublicKey(), appUserId: uid });
  const purchases = Purchases.getSharedInstance();
  if (purchases.getAppUserId() !== uid) { quoteCache.clear(); await purchases.changeUser(uid); }
  return purchases;
}// UX-PLAY-1: owner configuration carries the actual goog_ key and is awaited
// before any native read, quote or purchase; the configured session is reused
// only when both owner and generation still match.
async function ensureNativeSession(): Promise<NativeBillingSession> {
  const ownerUid = currentUid();
  if (nativeConfigured && nativeConfigured.ownerUid === ownerUid && nativeConfigured.generation === nativeGeneration) {
    return nativeConfigured;
  }
  const session: NativeBillingSession = { ownerUid, generation: nativeGeneration };
  await configureNativeOwner(session, androidPublicKey());
  if (auth.currentUser?.uid !== ownerUid || nativeGeneration !== session.generation) {
    throw new CheckoutError('The signed-in account changed while preparing native billing; please retry.');
  }
  nativeConfigured = session;
  return session;
}
function findConfiguredPackage(offerings: Awaited<ReturnType<Purchases['getOfferings']>>, mapping: PlatformMapping): Package {
  const offeringId = offeringIdentifier();
  const offering = offerings.all[offeringId];
  if (!offering) throw new CheckoutError(`RevenueCat offering "${offeringId}" is not configured; refusing to use the current or default offering.`);
  const rcPackage: Package | undefined = offering.packagesById[mapping.packageIdentifier];
  if (!rcPackage) throw new CheckoutError(`Package "${mapping.packageIdentifier}" is missing from offering "${offeringId}".`);
  if (rcPackage.product?.identifier !== mapping.productIdentifier) {
    throw new CheckoutError(
      `Package "${mapping.packageIdentifier}" maps to product "${rcPackage.product?.identifier}" instead of the expected "${mapping.productIdentifier}".`,
    );
  }
  return rcPackage;
}
function validatedPrice(rcPackage: Package): { formattedPrice: string; amountMicros: number; currency: string } {
  const { amountMicros, currency, formattedPrice } = rcPackage.product?.price ?? {};
  if (
    typeof amountMicros !== 'number' || !Number.isSafeInteger(amountMicros) || amountMicros <= 0 ||
    typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency) ||
    typeof formattedPrice !== 'string' || formattedPrice.length === 0
  ) {
    throw new CheckoutError(`Product "${rcPackage.product?.identifier}" returned no valid live price; refusing to fabricate one.`);
  }
  return { formattedPrice, amountMicros, currency };
}
// UX-PLAY-1: Web SDK Product exposes productType (not type) on 1.73.1.
function webProductType(rcPackage: Package): 'subscription' | 'one_time' {
  const productType = rcPackage.product?.productType;
  if (productType === 'subscription') return 'subscription';
  if (productType === 'consumable' || productType === 'non_consumable') return 'one_time';
  throw new CheckoutError(`Product "${rcPackage.product?.identifier}" has unsupported type "${String(productType)}"; refusing to guess.`);
}
function randomQuoteId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
function requireStringField(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  if (typeof value !== 'string' || value.length === 0) throw new CheckoutError(`The native response is missing a valid "${field}".`);
  return value;
}
// UX-PLAY-1: the native quote is verified against the requested mapping, real
// price fields, product-type-specific period rules and a bounded expiry.
function normalizeNativeQuote(session: NativeBillingSession, kind: PurchaseKind, mapping: PlatformMapping, response: Record<string, unknown>): CheckoutOffer {
  if (response.kind !== kind) throw new CheckoutError('The native quote returned a different purchase kind than requested.');
  if (response.packageIdentifier !== mapping.packageIdentifier || response.productIdentifier !== mapping.productIdentifier) {
    throw new CheckoutError('The native quote does not match the requested package and product binding.');
  }
  const expiresAt = response.expiresAt;
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 120000) {
    throw new CheckoutError('The native quote carries an invalid expiry; please retry.');
  }
  const productType = response.productType;
  if (productType !== 'subscription' && productType !== 'one_time') {
    throw new CheckoutError(`The native quote has unsupported product type "${String(productType)}".`);
  }
  const billingPeriod = typeof response.billingPeriod === 'string' && response.billingPeriod.length > 0 ? response.billingPeriod : null;
  if (productType === 'subscription' && billingPeriod === null) throw new CheckoutError('The native subscription quote carries no actual billing period.');
  if (productType === 'one_time' && billingPeriod !== null) throw new CheckoutError('The native one-time quote carries an unexpected billing period.');
  const amountMicros = response.amountMicros;
  if (typeof amountMicros !== 'number' || !Number.isSafeInteger(amountMicros) || amountMicros <= 0) throw new CheckoutError('The native quote carries no valid positive price amount.');
  if (typeof response.currency !== 'string' || !/^[A-Z]{3}$/.test(response.currency)) throw new CheckoutError('The native quote carries no valid currency code.');
  return Object.freeze({
    kind,
    ownerUid: session.ownerUid,
    quoteId: requireStringField(response, 'quoteId'),
    packageIdentifier: mapping.packageIdentifier,
    productIdentifier: mapping.productIdentifier,
    formattedPrice: requireStringField(response, 'formattedPrice'),
    amountMicros,
    currency: response.currency,
    expiresAt,
    productType,
    billingPeriod,
    productTitle: requireStringField(response, 'productTitle'),
  });
}
// UX-PLAY-1: the native customer projection is verified, never cast. A missing
// or non-finite expiry is unknown, not unlimited, and every active entitlement
// must have its own expiry entry.
function normalizeNativeCustomer(ownerUid: string, raw: unknown): CheckoutCustomer {
  if (!raw || typeof raw !== 'object') throw new CheckoutError('The native billing plugin returned no customer projection.');
  const candidate = raw as { ownerUid?: unknown; activeEntitlementIds?: unknown; entitlementExpirations?: unknown; purchasedProductIds?: unknown };
  if (candidate.ownerUid !== ownerUid) throw new CheckoutError('The native customer projection belongs to a different owner.');
  const idsValid = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((id): id is string => typeof id === 'string');
  if (!idsValid(candidate.activeEntitlementIds)) throw new CheckoutError('The native customer projection has invalid active entitlements.');
  if (!idsValid(candidate.purchasedProductIds)) throw new CheckoutError('The native customer projection has invalid purchased products.');
  if (!candidate.entitlementExpirations || typeof candidate.entitlementExpirations !== 'object') {
    throw new CheckoutError('The native customer projection has invalid entitlement expirations.');
  }
  const entitlementExpirations: Record<string, number | null> = {};
  for (const [id, expiry] of Object.entries(candidate.entitlementExpirations)) {
    if (expiry !== null && (typeof expiry !== 'number' || !Number.isFinite(expiry))) {
      throw new CheckoutError('The native customer projection has an unknown entitlement expiry; refusing to treat it as unlimited.');
    }
    entitlementExpirations[id] = expiry;
  }
  for (const id of candidate.activeEntitlementIds) {
    if (!Object.prototype.hasOwnProperty.call(entitlementExpirations, id)) {
      throw new CheckoutError('The native customer projection is missing the expiry of an active entitlement.');
    }
  }
  return { ownerUid, activeEntitlementIds: candidate.activeEntitlementIds, entitlementExpirations, purchasedProductIds: candidate.purchasedProductIds };
}
// UX-PLAY-1: the Web SDK CustomerInfo is projected into CheckoutCustomer.
function projectWebCustomer(ownerUid: string, info: CustomerInfo): CheckoutCustomer {
  const entitlementExpirations: Record<string, number | null> = {};
  for (const [id, entitlement] of Object.entries(info.entitlements.active ?? {})) {
    entitlementExpirations[id] = entitlement.expirationDate instanceof Date ? entitlement.expirationDate.getTime() : null;
  }
  const purchased = new Set<string>();
  for (const [product, date] of Object.entries(info.allPurchaseDatesByProduct ?? {})) {
    if (date) purchased.add(product);
  }
  for (const transaction of info.nonSubscriptionTransactions ?? []) purchased.add(transaction.productIdentifier);
  return { ownerUid, activeEntitlementIds: Object.keys(entitlementExpirations), entitlementExpirations, purchasedProductIds: [...purchased] };
}
export function getCheckoutOffer(input: PurchaseKind): Promise<CheckoutOffer> {
  const kind = validateKind(input);
  if (purchaseInFlight) {
    return Promise.reject(new CheckoutError('Another checkout is already in progress; wait for it to finish before starting a new one.'));
  }
  return serialize(async () => {
    const entryGeneration = authGeneration;
    await auth.authStateReady();
    assertGeneration(entryGeneration);
    if (await isNativeAndroid()) {
      assertGeneration(entryGeneration);
      const mapping = requiredMapping(kind, 'android');
      const session = await ensureNativeSession();
      assertGeneration(entryGeneration);
      const response = await quoteNativeOffer(session, kind, {
        publicKey: androidPublicKey(),
        offeringIdentifier: offeringIdentifier(),
        packageIdentifier: mapping.packageIdentifier,
        productIdentifier: mapping.productIdentifier,
      });
      assertGeneration(entryGeneration);
      const offer = normalizeNativeQuote(session, kind, mapping, response);
      quoteCache.set(offer.quoteId, { ...offer, platform: 'native', sessionGeneration: session.generation, offer });
      return offer;
    }
    const ownerUid = currentUid();
    const purchases = await ensureSdkForOwner(ownerUid);
    assertGeneration(entryGeneration);
    if (purchases.getAppUserId() !== ownerUid || auth.currentUser?.uid !== ownerUid) {
      throw new CheckoutError('The RevenueCat SDK is not bound to the current signed-in account; please retry.');
    }
    const mapping = requiredMapping(kind, 'web');
    const offerings = await purchases.getOfferings();
    assertGeneration(entryGeneration);
    if (purchases.getAppUserId() !== ownerUid || auth.currentUser?.uid !== ownerUid) {
      throw new CheckoutError('Signed-in account changed while loading the checkout offer; please retry.');
    }
    const rcPackage = findConfiguredPackage(offerings, mapping);
    const price = validatedPrice(rcPackage);
    const productTitle = rcPackage.product?.title ?? '';
    if (productTitle.length === 0) throw new CheckoutError(`Product "${mapping.productIdentifier}" returned no title; refusing to fabricate one.`);
    const offer: CheckoutOffer = Object.freeze({
      kind,
      ownerUid,
      quoteId: randomQuoteId(),
      packageIdentifier: mapping.packageIdentifier,
      productIdentifier: mapping.productIdentifier,
      formattedPrice: price.formattedPrice,
      amountMicros: price.amountMicros,
      currency: price.currency,
      expiresAt: Date.now() + QUOTE_TTL_MS,
      productType: webProductType(rcPackage),
      billingPeriod: rcPackage.product?.normalPeriodDuration ?? null,
      productTitle,
    });
    quoteCache.set(offer.quoteId, { ...offer, platform: 'web', sessionGeneration: entryGeneration, rcPackage, offer });
    for (const [id, entry] of quoteCache) {
      if (Date.now() >= entry.expiresAt) quoteCache.delete(id);
    }
    return offer;
  });
}
function isUserCancelled(error: unknown): boolean {
  return error instanceof PurchasesError && error.errorCode === ErrorCode.UserCancelledError;
}
export function purchaseCheckoutOffer(offer: CheckoutOffer, htmlTarget?: HTMLElement): Promise<CheckoutPurchaseOutcome> {
  if (purchaseInFlight) {
    return Promise.reject(new CheckoutError('Another checkout is already in progress; wait for it to finish before starting a new one.'));
  }
  purchaseInFlight = true;
  return serialize(async (): Promise<CheckoutPurchaseOutcome> => {
    try {
      const entryGeneration = authGeneration;
      await auth.authStateReady();
      assertGeneration(entryGeneration);
      // UX-PLAY-1: the JS cache is consumed before any dispatch; a native
      // second submission is rejected here and never reaches the plugin.
      const cached = quoteCache.get(offer.quoteId);
      quoteCache.delete(offer.quoteId);
      if (!cached || cached.offer !== offer) {
        throw new CheckoutError('This checkout offer is not recognized; fetch a fresh offer before purchasing.');
      }
      if (Date.now() >= cached.expiresAt) throw new CheckoutError('This checkout offer has expired; fetch a fresh offer before purchasing.');
      const ownerUid = currentUid();
      if (ownerUid !== cached.ownerUid || ownerUid !== offer.ownerUid) {
        throw new CheckoutError('This checkout offer belongs to a different signed-in account.');
      }
      if (cached.platform === 'native') {
        const session = await ensureNativeSession();
        assertGeneration(entryGeneration);
        if (session.ownerUid !== cached.ownerUid || session.generation !== cached.sessionGeneration) {
          throw new CheckoutError('This checkout offer belongs to an earlier native billing session; fetch a fresh offer.');
        }
        const response = await purchaseNativeOffer(session, offer.quoteId);
        assertGeneration(entryGeneration);
        if (response.state === 'cancelled') return { state: 'cancelled' };
        if (response.state === 'pending') return { state: 'pending' };
        if (response.state === 'purchased') {
          return { state: 'purchased', customerInfo: normalizeNativeCustomer(offer.ownerUid, response.customer) };
        }
        throw new CheckoutError('The store returned an unrecognized purchase state.');
      }
      if (cached.rcPackage === undefined) {
        throw new CheckoutError('The cached web offer is missing its package; fetch a fresh offer before purchasing.');
      }
      const purchases = await ensureSdkForOwner(ownerUid);
      assertGeneration(entryGeneration);
      if (purchases.getAppUserId() !== ownerUid || auth.currentUser?.uid !== ownerUid) {
        throw new CheckoutError('The RevenueCat SDK is not bound to the current signed-in account; please retry.');
      }
      const mapping = requiredMapping(cached.kind, 'web');
      if (cached.rcPackage.identifier !== mapping.packageIdentifier || cached.rcPackage.product?.identifier !== mapping.productIdentifier) {
        throw new CheckoutError('The cached offer no longer matches the configured package mapping.');
      }
      let result: PurchaseResult;
      try {
        // Native RevenueCat validates the discount code and shows the adjusted total itself;
        // labelsOverride is experimental on the pinned 1.73.1 SDK surface (typed locally since it is excluded from public types).
        const purchaseParams: Parameters<Purchases['purchase']>[0] & {
          labelsOverride: { en: { 'discount_input.label': string } };
        } = {
          rcPackage: cached.rcPackage,
          customerEmail: auth.currentUser?.email ?? undefined,
          htmlTarget,
          termsAndConditionsUrl: termsUrl(),
          skipSuccessPage: true,
          showDiscountCodeField: true,
          labelsOverride: { en: { 'discount_input.label': 'Have a code?' } },
        };
        result = await purchases.purchase(purchaseParams);
      } catch (error) {
        if (isUserCancelled(error)) return { state: 'cancelled' };
        throw new CheckoutError('The card checkout could not be completed.', { cause: error });
      }
      assertGeneration(entryGeneration);
      if (auth.currentUser?.uid !== cached.ownerUid) {
        throw new CheckoutError(
          'The signed-in account changed during checkout; the completed payment must be reconciled by the provider for the paying account.',
          { cause: result },
        );
      }
      return { state: 'purchased', customerInfo: projectWebCustomer(cached.ownerUid, result.customerInfo) };
    } finally {
      purchaseInFlight = false;
    }
  });
}
// UX-PLAY-1: passive customer read (no restore) for offer suppression and
// entitlement checks; restore=true triggers a provider restore on native.
export async function getCheckoutCustomer(restore = false): Promise<CheckoutCustomer> {
  return serialize(async () => {
    const entryGeneration = authGeneration;
    await auth.authStateReady();
    assertGeneration(entryGeneration);
    if (await isNativeAndroid()) {
      const session = await ensureNativeSession();
      assertGeneration(entryGeneration);
      const response = await getNativeCustomer(session, restore);
      assertGeneration(entryGeneration);
      return normalizeNativeCustomer(session.ownerUid, response.customer);
    }
    const ownerUid = currentUid();
    const purchases = await ensureSdkForOwner(ownerUid);
    assertGeneration(entryGeneration);
    if (purchases.getAppUserId() !== ownerUid || auth.currentUser?.uid !== ownerUid) {
      throw new CheckoutError('The RevenueCat SDK is not bound to the current signed-in account; please retry.');
    }
    const customerInfo = await purchases.getCustomerInfo();
    assertGeneration(entryGeneration);
    if (auth.currentUser?.uid !== ownerUid) throw new CheckoutError('Signed-in account changed while loading the customer; please retry.');
    return projectWebCustomer(ownerUid, customerInfo);
  });
}
export function restoreCheckoutCustomer(): Promise<CheckoutCustomer> {
  if (purchaseInFlight) {
    return Promise.reject(new CheckoutError('Another checkout is already in progress; wait for it to finish before restoring.'));
  }
  return getCheckoutCustomer(true);
}
export type RocheBalance = { ownerUid: string; currency: 'ROCHE'; balance: number; fetchedAt: number };
export function getRocheBalance(): Promise<RocheBalance> {
  if (purchaseInFlight) {
    return Promise.reject(new CheckoutError('Another checkout is already in progress; wait for it to finish before starting a new one.'));
  }
  return serialize(async () => {
    const entryGeneration = authGeneration;
    await auth.authStateReady();
    assertGeneration(entryGeneration);
    const ownerUid = currentUid();
    if (await isNativeAndroid()) {
      const session = await ensureNativeSession();
      assertGeneration(entryGeneration);
      const response = await getNativeRocheBalance(session);
      assertGeneration(entryGeneration);
      const { balance, fetchedAt } = response as { balance?: unknown; fetchedAt?: unknown };
      if (response.currency !== 'ROCHE') throw new CheckoutError('The store returned a currency other than ROCHE.');
      if (typeof balance !== 'number' || !Number.isSafeInteger(balance) || balance < 0) {
        throw new CheckoutError('Your ROCHE balance could not be loaded. Please try again.');
      }
      if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt)) {
        throw new CheckoutError('Your ROCHE balance has no valid fetch time. Please try again.');
      }
      return { ownerUid, currency: 'ROCHE', balance, fetchedAt };
    }
    const purchases = await ensureSdkForOwner(ownerUid);
    assertGeneration(entryGeneration);
    if (purchases.getAppUserId() !== ownerUid || auth.currentUser?.uid !== ownerUid) {
      throw new CheckoutError('The RevenueCat SDK is not bound to the current signed-in account; please retry.');
    }
    await purchases.invalidateVirtualCurrenciesCache();
    const virtualCurrencies = await purchases.getVirtualCurrencies();
    assertGeneration(entryGeneration);
    if (purchases.getAppUserId() !== ownerUid || auth.currentUser?.uid !== ownerUid) {
      throw new CheckoutError('Signed-in account changed while loading the ROCHE balance; please retry.');
    }
    const roche = virtualCurrencies.all.ROCHE;
    const balance = roche?.balance;
    if (roche?.code !== 'ROCHE' || typeof balance !== 'number' || !Number.isSafeInteger(balance) || balance < 0) {
      throw new CheckoutError('Your ROCHE balance could not be loaded. Please try again.');
    }
    return { ownerUid, currency: 'ROCHE', balance, fetchedAt: Date.now() };
  }); }
installAuthListener();
