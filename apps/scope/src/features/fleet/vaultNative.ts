import { requireOptionalNativeModule } from "expo";

/** The ScopeVault native module (modules/scope-vault). Absent on Android and in tests. */
interface ScopeVaultNative {
  isHardwareBacked(): boolean;
  ensureKey(): Promise<string>;
  resetKey(): Promise<string>;
  unlock(
    deviceId: string,
    wrappedEnc: string,
    wrappedCt: string,
    hubPublicKey: string,
    challengeId: string,
    reason: string,
  ): Promise<{ enc: string; ct: string }>;
}

export const scopeVault = requireOptionalNativeModule<ScopeVaultNative>("ScopeVault");
