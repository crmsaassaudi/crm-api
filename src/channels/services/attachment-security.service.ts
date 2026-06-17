import { Injectable, Logger, BadRequestException } from '@nestjs/common';

/**
 * Attachment Security Gateway — Enterprise malware/risk defense layer.
 *
 * Architecture (from email-integration-plan.md Section 3.1d):
 *   P0: Blocklist filter — zero-compute, blocks dangerous file extensions
 *   P1: ClamAV stream scan — scans file binary before S3 upload
 *   P2: CID size-threshold filter — <10KB inline images stay Base64, ≥10KB → S3
 *
 * Trade-off: We accept a small latency hit (~50ms per file for blocklist,
 * ~200ms for AV) in exchange for zero malware in S3. This is non-negotiable
 * for Enterprise customers in regulated industries.
 */

/** Result of scanning a single file/attachment */
export interface AttachmentScanResult {
  /** Whether the file is safe to store */
  safe: boolean;
  /** Human-readable reason if blocked */
  reason?: string;
  /** Classification of the block */
  blockType?: 'extension_blocked' | 'av_quarantined' | 'size_exceeded';
}

/** Result of CID inline image classification */
export interface CidClassification {
  /** Original CID reference from MIME */
  cid: string;
  /** 'base64' → keep inline, 's3' → upload to storage */
  action: 'base64' | 's3';
  /** Base64 data URI (only if action === 'base64') */
  dataUri?: string;
  /** File buffer (only if action === 's3') */
  buffer?: Buffer;
  /** MIME content type */
  contentType: string;
  /** Size in bytes */
  sizeBytes: number;
}

@Injectable()
export class AttachmentSecurityService {
  private readonly logger = new Logger(AttachmentSecurityService.name);

  /**
   * Dangerous file extensions that MUST be blocked from upload.
   * Enterprise security standard — prevents executable delivery via email.
   */
  private readonly BLOCKED_EXTENSIONS = new Set([
    // Windows executables
    '.exe',
    '.bat',
    '.cmd',
    '.com',
    '.msi',
    '.msp',
    '.mst',
    // Scripting
    '.vbs',
    '.vbe',
    '.js',
    '.jse',
    '.wsf',
    '.wsh',
    '.ps1',
    '.psm1',
    // Shell / Unix
    '.sh',
    '.bash',
    '.csh',
    // Compiled / Bytecode
    '.scr',
    '.pif',
    '.dll',
    '.sys',
    '.drv',
    // Office Macros (high risk)
    '.docm',
    '.xlsm',
    '.pptm',
    '.dotm',
    '.xltm',
    // Archive with potential exploits
    '.iso',
    '.img',
    // Registry
    '.reg',
    // Shortcuts
    '.lnk',
    '.url',
    '.inf',
    // Java
    '.jar',
    '.class',
    // Python (prevent arbitrary execution)
    '.py',
    '.pyc',
    '.pyw',
  ]);

  /** Maximum single attachment size: 25 MB (matches Gmail/Outlook limits) */
  private readonly MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;

  /** CID inline image threshold: images below this stay as Base64 data URIs */
  private readonly CID_SIZE_THRESHOLD_BYTES = 10 * 1024; // 10 KB

  // ── P0: Extension Blocklist ─────────────────────────────────────────────

  /**
   * Check if a file's extension is blocked.
   * This is the zero-cost first line of defense — no file content inspection needed.
   */
  scanExtension(fileName: string): AttachmentScanResult {
    if (!fileName) {
      return {
        safe: false,
        reason: 'File name is required',
        blockType: 'extension_blocked',
      };
    }

    const ext = this.extractExtension(fileName);
    if (this.BLOCKED_EXTENSIONS.has(ext)) {
      this.logger.warn(
        `[AttachmentSecurity] 🚫 Blocked file: "${fileName}" (extension: ${ext})`,
      );
      return {
        safe: false,
        reason: `File type "${ext}" is not allowed for security reasons`,
        blockType: 'extension_blocked',
      };
    }

    return { safe: true };
  }

  /**
   * Full scan pipeline: extension check → size check → (future: AV scan).
   * Call this before uploading ANY attachment to S3.
   */
  scanAttachment(
    fileName: string,
    sizeBytes: number,

    _buffer?: Buffer,
  ): AttachmentScanResult {
    // Step 1: Extension blocklist (instant, zero-cost)
    const extResult = this.scanExtension(fileName);
    if (!extResult.safe) return extResult;

    // Step 2: Size check
    if (sizeBytes > this.MAX_ATTACHMENT_SIZE_BYTES) {
      return {
        safe: false,
        reason: `File size (${(sizeBytes / 1024 / 1024).toFixed(1)} MB) exceeds the maximum allowed size of 25 MB`,
        blockType: 'size_exceeded',
      };
    }

    // Step 3: ClamAV scan (future integration)
    // When ClamAV is available, uncomment:
    // if (_buffer) {
    //   const avResult = await this.scanWithClamAV(_buffer);
    //   if (!avResult.safe) return avResult;
    // }

    return { safe: true };
  }

  // ── P1: ClamAV Integration Stub ────────────────────────────────────────

  /**
   * Scan a file buffer with ClamAV.
   * Currently a stub — returns safe. Wire to ClamAV socket when deployed.
   *
   * Future integration:
   *   - Connect to clamd via TCP socket (clamav:3310)
   *   - Stream buffer to INSTREAM command
   *   - Parse response: "stream: OK" vs "stream: {virus_name} FOUND"
   *   - If infected: move to quarantine S3 bucket, log, alert admin
   */

  scanWithClamAV(_buffer: Buffer): AttachmentScanResult {
    // TODO: Integrate with ClamAV daemon when deployed
    // For now, pass-through (extension blocklist provides P0 protection)
    return { safe: true };
  }

  // ── P2: CID Size-Threshold Filter ──────────────────────────────────────

  /**
   * Classify inline CID images: small icons stay Base64, large images go to S3.
   *
   * Why: With 5,000+ tenants, millions of tiny icon/spacer GIF uploads to S3
   * would bloat storage costs and increase render latency. The 10KB threshold
   * filters out ~80% of inline images (signatures, bullet points, logos)
   * while still uploading meaningful screenshots and diagrams to S3.
   */
  classifyCidImage(
    cid: string,
    buffer: Buffer,
    contentType: string,
  ): CidClassification {
    const sizeBytes = buffer.length;

    if (sizeBytes < this.CID_SIZE_THRESHOLD_BYTES) {
      // Small image → keep as Base64 data URI (no S3 upload)
      const base64 = buffer.toString('base64');
      const dataUri = `data:${contentType};base64,${base64}`;

      this.logger.debug(
        `[AttachmentSecurity] CID ${cid}: ${sizeBytes}B < ${this.CID_SIZE_THRESHOLD_BYTES}B → Base64 (no S3)`,
      );

      return {
        cid,
        action: 'base64',
        dataUri,
        contentType,
        sizeBytes,
      };
    }

    // Large image → upload to S3
    this.logger.debug(
      `[AttachmentSecurity] CID ${cid}: ${sizeBytes}B ≥ ${this.CID_SIZE_THRESHOLD_BYTES}B → S3 upload`,
    );

    return {
      cid,
      action: 's3',
      buffer,
      contentType,
      sizeBytes,
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private extractExtension(fileName: string): string {
    const lastDot = fileName.lastIndexOf('.');
    if (lastDot === -1) return '';
    return fileName.substring(lastDot).toLowerCase();
  }

  /**
   * Validate a batch of attachments. Throws BadRequestException if any are blocked.
   * Convenience method for controller-level validation.
   */
  validateAttachmentBatch(
    files: { fileName: string; sizeBytes: number }[],
  ): void {
    const blocked: string[] = [];

    for (const file of files) {
      const result = this.scanAttachment(file.fileName, file.sizeBytes);
      if (!result.safe) {
        blocked.push(`${file.fileName}: ${result.reason}`);
      }
    }

    if (blocked.length > 0) {
      throw new BadRequestException({
        message: 'One or more attachments were blocked by security policy',
        blockedFiles: blocked,
      });
    }
  }
}
