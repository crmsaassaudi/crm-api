/**
 * ConnectionAdapter — Base interface for provider-specific connection verification.
 *
 * Each provider implements this to validate credentials before they're encrypted and stored.
 * The Adapter Registry routes verifyConnection calls to the correct implementation.
 */
export interface ConnectionAdapter {
  /** Must match the providerType in the ProviderSchema registry */
  readonly providerType: string;

  /**
   * Verify that the given credentials and settings are valid.
   * Makes a lightweight API call to the provider to check authentication.
   *
   * @returns success=true if credentials are valid, or success=false with error message
   */
  verifyConnection(
    credentials: Record<string, any>,
    settings: Record<string, any>,
  ): Promise<ConnectionVerifyResult>;
}

export interface ConnectionVerifyResult {
  success: boolean;
  error?: string;
}
