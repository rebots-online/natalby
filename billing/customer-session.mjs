// Customer-scoped OpenRouter session key binding for Natally.
//
// Resolves (or creates) a RevenueCat V2 customer whose id equals the Firebase
// UID, reconciles the customer's OpenRouter provisioning key against its
// stored key/hash association, funds it from the customer's ROCHE balance via
// a caller-supplied conversion callback, and persists the association.
//
// This module owns NO persistence, NO concurrency control, and NO conversion
// default. Every provider/customer operation runs inside the caller-supplied
// withCustomerOperation(uid, asyncOperation) boundary, which is also
// responsible for recovering interrupted key issuance.

import {
  readCustomer,
  createCustomer,
  readCustomerRoche,
  readCustomerKey,
  saveCustomerKey,
} from "./revenuecat-customer.mjs";
import { reconcileManagedKey, disableManagedKey } from "./openrouter.mjs";

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertSyncOptions(uid, options, { requireLimit = false } = {}) {
  assertNonEmptyString(uid, "uid");
  if (typeof options?.withCustomerOperation !== "function") {
    throw new Error("withCustomerOperation must be a function");
  }
  if (requireLimit && typeof options.limitFromRoche !== "function") {
    throw new Error("limitFromRoche must be a function");
  }
}

export async function syncCustomerSessionKey(uid, options) {
  assertSyncOptions(uid, options, { requireLimit: true });
  return options.withCustomerOperation(uid, async () => {
    try {
      await readCustomer(uid, options.revenueCat);
    } catch (error) {
      if (error?.status !== 404) throw error;
      await createCustomer(uid, options.revenueCat);
    }

    const association = await readCustomerKey(uid, options.revenueCat);
    const existingKeyHash = association === null ? null : association.hash;
    const existingKey = association === null ? null : association.key;

    let snapshot = null;
    let limitUsd = null;
    const readLimitUsd = async () => {
      snapshot = await readCustomerRoche(uid, options.revenueCat);
      limitUsd = await options.limitFromRoche(snapshot);
      if (!Number.isFinite(limitUsd) || limitUsd < 0 ||
          (snapshot.balance === 0 ? limitUsd !== 0 : limitUsd === 0)) {
        throw new Error("ROCHE conversion must preserve zero and produce a positive finite limit for positive ROCHE");
      }
      return limitUsd;
    };

    const resolved = await reconcileManagedKey(
      { existingKeyHash, existingKey, name: `Natally ${uid}`, readLimitUsd },
      options.openRouter,
    );

    await saveCustomerKey(
      uid,
      { key: resolved.key, hash: resolved.hash },
      options.revenueCat,
    );

    return {
      state: limitUsd > 0 ? "ready" : "unfunded",
      customerId: uid,
      roche: snapshot.balance,
      limitUsd,
      key: resolved.key,
      hash: resolved.hash,
      keyState: resolved.state,
      data: resolved.data,
    };
  });
}

export async function deactivateCustomerSessionKey(uid, expectedHash, options) {
  assertSyncOptions(uid, options);
  assertNonEmptyString(expectedHash, "expectedHash");
  return options.withCustomerOperation(uid, async () => {
    const association = await readCustomerKey(uid, options.revenueCat);
    if (association === null || association.hash !== expectedHash) {
      return { deactivated: false };
    }
    await disableManagedKey(association.hash, options.openRouter);
    return { deactivated: true };
  });
}
