import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'crypto';

/**
 * ICryptoService -- Abstract interface for credential encryption.
 *
 * Implementations:
 *   - EnvCryptoService: AES-256-GCM using key from CHANNEL_ENCRYPTION_KEY env var
 *   - KmsCryptoService: AWS KMS envelope encryption (production-grade)
 *
 * Factory selection via ENCRYPTION_PROVIDER env var (default: 'env').
 *
 * Output formats:
 *   - Env:  base64(iv):base64(authTag):base64(ciphertext)
 *   - KMS:  kms:base64(encryptedDataKey):base64(iv):base64(authTag):base64(ciphertext)
 *
 * v4.0: Interface is now ASYNC to support network-based KMS calls.
 */
export interface ICryptoService {
  encrypt(plaintext: string): Promise<string>;
  decrypt(encrypted: string): Promise<string>;
}

export const CRYPTO_SERVICE_TOKEN = 'CRYPTO_SERVICE';

// -- AES-256-GCM Implementation (Env-based key) ---------------------------

@Injectable()
export class EnvCryptoService implements ICryptoService, OnModuleInit {
  private readonly logger = new Logger(EnvCryptoService.name);
  private key!: Buffer;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const rawKey = this.configService.get<string>('CHANNEL_ENCRYPTION_KEY', {
      infer: true,
    });

    if (!rawKey) {
      this.logger.warn(
        '[CryptoService] No CHANNEL_ENCRYPTION_KEY found -- using derived fallback key. ' +
          'This is ONLY acceptable for development.',
      );
      // Derive a deterministic key from a fixed salt for dev convenience
      this.key = scryptSync('dev-fallback-key', 'crm-dev-salt', 32);
      return;
    }

    // Support both raw hex keys (64 chars) and arbitrary passphrases
    if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
      this.key = Buffer.from(rawKey, 'hex');
    } else {
      this.key = scryptSync(rawKey, 'crm-channel-config', 32);
    }

    this.logger.log('[CryptoService] AES-256-GCM initialized (env mode)');
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async encrypt(plaintext: string): Promise<string> {
    const iv = randomBytes(16); // Random IV per encryption -- critical for GCM security
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'base64');
    encrypted += cipher.final('base64');

    const authTag = cipher.getAuthTag();

    // Format: iv:authTag:ciphertext (all base64)
    return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async decrypt(encrypted: string): Promise<string> {
    const parts = encrypted.split(':');
    if (parts.length !== 3) {
      throw new Error(
        'Invalid encrypted format. Expected iv:authTag:ciphertext',
      );
    }

    const [ivB64, authTagB64, ciphertext] = parts;
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');

    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }
}

// -- AWS KMS Envelope Encryption (Production-grade) -----------------------

/**
 * KmsCryptoService -- AWS KMS Envelope Encryption.
 *
 * Architecture: Envelope Encryption (same pattern as AWS S3 SSE-KMS, Stripe, Salesforce)
 *   1. KMS generates a unique DataKey per encrypt call
 *   2. DataKey (plaintext) encrypts credentials locally via AES-256-GCM
 *   3. KMS-encrypted DataKey is stored alongside ciphertext
 *   4. Plaintext DataKey is zeroed from memory immediately
 *
 * ENCRYPT:
 *   KMS.GenerateDataKey(CMK) -> { PlaintextKey, EncryptedKey }
 *   AES-256-GCM(PlaintextKey, credentials) -> ciphertext
 *   Store: kms:{EncryptedKey}:{iv}:{authTag}:{ciphertext}
 *   Zero(PlaintextKey)
 *
 * DECRYPT:
 *   KMS.Decrypt(EncryptedKey) -> { PlaintextKey }
 *   AES-256-GCM-Decrypt(PlaintextKey, ciphertext) -> credentials
 *   Zero(PlaintextKey)
 *
 * Why Envelope Encryption?
 *   - KMS has a 4KB plaintext limit; credentials can exceed this
 *   - Reduces KMS API calls; bulk crypto is local (~0.1ms) vs KMS (~10-30ms)
 *   - Industry standard pattern for field-level encryption
 *
 * Security:
 *   - CMK (Customer Master Key) never leaves KMS
 *   - DataKey is ephemeral; unique per encryption
 *   - Key rotation: AWS KMS handles CMK rotation automatically
 */
@Injectable()
export class KmsCryptoService implements ICryptoService, OnModuleInit {
  private readonly logger = new Logger(KmsCryptoService.name);
  private kmsClient: any; // KMSClient -- dynamically imported
  private keyId!: string;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    this.keyId = this.configService.getOrThrow<string>('AWS_KMS_KEY_ID', {
      infer: true,
    });
    const region =
      this.configService.get<string>('AWS_KMS_REGION', { infer: true }) ||
      this.configService.get<string>('AWS_REGION', { infer: true }) ||
      'ap-southeast-1';

    // Dynamic import to avoid bundling KMS SDK when using env mode
    const { KMSClient } = await import('@aws-sdk/client-kms');
    this.kmsClient = new KMSClient({ region });

    this.logger.log(
      `[CryptoService] KMS Envelope Encryption initialized (region=${region}, keyId=${this.keyId.substring(0, 20)}...)`,
    );
  }

  async encrypt(plaintext: string): Promise<string> {
    const { GenerateDataKeyCommand } = await import('@aws-sdk/client-kms');

    // 1. Generate a unique DataKey per encryption (envelope encryption)
    const response = await this.kmsClient.send(
      new GenerateDataKeyCommand({
        KeyId: this.keyId,
        KeySpec: 'AES_256',
      }),
    );

    const dataKeyPlaintext = Buffer.from(response.Plaintext!);
    const encryptedDataKey = Buffer.from(response.CiphertextBlob!);

    try {
      // 2. Local AES-256-GCM with the plaintext DataKey
      const iv = randomBytes(16);
      const cipher = createCipheriv('aes-256-gcm', dataKeyPlaintext, iv);
      let encrypted = cipher.update(plaintext, 'utf8', 'base64');
      encrypted += cipher.final('base64');
      const authTag = cipher.getAuthTag();

      // 3. Format: kms:encryptedDataKey:iv:authTag:ciphertext
      return [
        'kms',
        encryptedDataKey.toString('base64'),
        iv.toString('base64'),
        authTag.toString('base64'),
        encrypted,
      ].join(':');
    } finally {
      // 4. Zero-out plaintext DataKey from memory (security hygiene)
      dataKeyPlaintext.fill(0);
    }
  }

  async decrypt(encrypted: string): Promise<string> {
    if (!encrypted.startsWith('kms:')) {
      throw new Error(
        'Legacy env-based encryption format detected in KMS mode. ' +
          'Re-encrypt credentials using the KMS provider.',
      );
    }

    const { DecryptCommand } = await import('@aws-sdk/client-kms');

    const parts = encrypted.split(':');
    if (parts.length !== 5) {
      throw new Error(
        'Invalid KMS encrypted format. Expected kms:encryptedDataKey:iv:authTag:ciphertext',
      );
    }

    const [, encDataKeyB64, ivB64, authTagB64, ciphertext] = parts;

    // 1. Unwrap DataKey via KMS
    const response = await this.kmsClient.send(
      new DecryptCommand({
        CiphertextBlob: Buffer.from(encDataKeyB64, 'base64'),
      }),
    );

    const dataKeyPlaintext = Buffer.from(response.Plaintext!);

    try {
      // 2. Local AES-256-GCM decrypt
      const decipher = createDecipheriv(
        'aes-256-gcm',
        dataKeyPlaintext,
        Buffer.from(ivB64, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));

      let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } finally {
      // 3. Zero-out DataKey from memory
      dataKeyPlaintext.fill(0);
    }
  }
}

// -- Bootstrap Halt Guard -------------------------------------------------

/**
 * Factory function for CRYPTO_SERVICE_TOKEN.
 *
 * Reads ENCRYPTION_PROVIDER env var:
 *   - 'env' (default): EnvCryptoService (dev/staging only)
 *   - 'kms': KmsCryptoService (production-grade, required for GA)
 *
 * Bootstrap Halt: If NODE_ENV=production and ENCRYPTION_PROVIDER=env,
 * the factory throws to prevent production deployment with env-only encryption.
 */
export function cryptoServiceFactory(
  configService: ConfigService,
): ICryptoService {
  const provider =
    configService.get<string>('ENCRYPTION_PROVIDER', { infer: true }) || 'env';
  const nodeEnv =
    configService.get<string>('NODE_ENV', { infer: true }) || 'development';

  // -- Bootstrap Halt: Production guard --
  if (nodeEnv === 'production' && provider === 'env') {
    throw new Error(
      'BOOTSTRAP HALT: Cannot use ENCRYPTION_PROVIDER=env in production. ' +
        'Set ENCRYPTION_PROVIDER=kms and configure AWS KMS credentials.',
    );
  }

  if (provider === 'kms') {
    return new KmsCryptoService(configService);
  }

  return new EnvCryptoService(configService);
}
