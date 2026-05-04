import { BadRequestException } from '@nestjs/common';
import { AttachmentSecurityService } from './attachment-security.service';

describe('AttachmentSecurityService', () => {
  let service: AttachmentSecurityService;

  beforeEach(() => {
    service = new AttachmentSecurityService();
  });

  // ────────────────────────────────────────────────────────────────────────
  // P0: Extension Blocklist
  // ────────────────────────────────────────────────────────────────────────
  describe('scanExtension()', () => {
    describe('should BLOCK dangerous file extensions', () => {
      const dangerousFiles = [
        // Windows executables
        'malware.exe',
        'script.bat',
        'command.cmd',
        'legacy.com',
        'installer.msi',
        'patch.msp',
        'transform.mst',
        // Scripting
        'script.vbs',
        'encoded.vbe',
        'hack.js',
        'encoded.jse',
        'script.wsf',
        'host.wsh',
        'powershell.ps1',
        'module.psm1',
        // Shell
        'script.sh',
        'script.bash',
        'script.csh',
        // Compiled
        'screensaver.scr',
        'info.pif',
        'library.dll',
        'driver.sys',
        'driver.drv',
        // Office macros
        'document.docm',
        'spreadsheet.xlsm',
        'presentation.pptm',
        'template.dotm',
        'excel-template.xltm',
        // Archive exploits
        'disk.iso',
        'image.img',
        // System
        'regedit.reg',
        'shortcut.lnk',
        'link.url',
        'setup.inf',
        // Java
        'app.jar',
        'App.class',
        // Python
        'script.py',
        'compiled.pyc',
        'windowless.pyw',
      ];

      it.each(dangerousFiles)('%s → blocked', (fileName) => {
        const result = service.scanExtension(fileName);
        expect(result.safe).toBe(false);
        expect(result.blockType).toBe('extension_blocked');
        expect(result.reason).toContain('not allowed');
      });
    });

    describe('should ALLOW safe file extensions', () => {
      const safeFiles = [
        'report.pdf',
        'contract.docx',
        'spreadsheet.xlsx',
        'slides.pptx',
        'photo.jpg',
        'screenshot.png',
        'diagram.gif',
        'image.webp',
        'data.csv',
        'document.txt',
        'config.json',
        'style.css',
        'archive.zip',
        'compressed.rar',
        'backup.7z',
        'video.mp4',
        'audio.mp3',
      ];

      it.each(safeFiles)('%s → allowed', (fileName) => {
        const result = service.scanExtension(fileName);
        expect(result.safe).toBe(true);
        expect(result.reason).toBeUndefined();
      });
    });

    it('should block case-insensitive extensions (.EXE, .Bat, .JS)', () => {
      expect(service.scanExtension('malware.EXE').safe).toBe(false);
      expect(service.scanExtension('script.Bat').safe).toBe(false);
      expect(service.scanExtension('hack.JS').safe).toBe(false);
    });

    it('should block files with multiple dots (invoice.pdf.exe)', () => {
      const result = service.scanExtension('invoice.pdf.exe');
      expect(result.safe).toBe(false);
      expect(result.blockType).toBe('extension_blocked');
    });

    it('should allow files without extension', () => {
      const result = service.scanExtension('Makefile');
      expect(result.safe).toBe(true);
    });

    it('should return blocked for empty fileName', () => {
      const result = service.scanExtension('');
      expect(result.safe).toBe(false);
      expect(result.reason).toBe('File name is required');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Full Scan Pipeline (Extension + Size + Future AV)
  // ────────────────────────────────────────────────────────────────────────
  describe('scanAttachment()', () => {
    it('should BLOCK dangerous extension before checking size', () => {
      const result = service.scanAttachment('virus.exe', 100);
      expect(result.safe).toBe(false);
      expect(result.blockType).toBe('extension_blocked');
    });

    it('should BLOCK files exceeding 25 MB', () => {
      const overSize = 26 * 1024 * 1024; // 26 MB
      const result = service.scanAttachment('big-file.zip', overSize);
      expect(result.safe).toBe(false);
      expect(result.blockType).toBe('size_exceeded');
      expect(result.reason).toContain('25 MB');
    });

    it('should ALLOW files at exactly 25 MB', () => {
      const exactLimit = 25 * 1024 * 1024;
      const result = service.scanAttachment('file.pdf', exactLimit);
      expect(result.safe).toBe(true);
    });

    it('should ALLOW small safe files', () => {
      const result = service.scanAttachment('report.pdf', 5000);
      expect(result.safe).toBe(true);
    });

    it('should check extension BEFORE size (block .exe even if small)', () => {
      const result = service.scanAttachment('tiny.bat', 10);
      expect(result.safe).toBe(false);
      expect(result.blockType).toBe('extension_blocked');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // P1: ClamAV Stub
  // ────────────────────────────────────────────────────────────────────────
  describe('scanWithClamAV()', () => {
    it('should return safe (stub implementation)', () => {
      const buffer = Buffer.from('file content');
      const result = service.scanWithClamAV(buffer);
      expect(result.safe).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // P2: CID Size-Threshold Filter
  // ────────────────────────────────────────────────────────────────────────
  describe('classifyCidImage()', () => {
    it('should classify small image (< 10KB) as Base64 with data URI', () => {
      const smallBuffer = Buffer.alloc(5 * 1024); // 5 KB
      smallBuffer.fill(0x89); // PNG-like bytes

      const result = service.classifyCidImage(
        'image001',
        smallBuffer,
        'image/png',
      );

      expect(result.cid).toBe('image001');
      expect(result.action).toBe('base64');
      expect(result.dataUri).toMatch(/^data:image\/png;base64,/);
      expect(result.sizeBytes).toBe(5 * 1024);
      expect(result.buffer).toBeUndefined();
    });

    it('should classify large image (>= 10KB) for S3 upload', () => {
      const largeBuffer = Buffer.alloc(15 * 1024); // 15 KB

      const result = service.classifyCidImage(
        'screenshot',
        largeBuffer,
        'image/jpeg',
      );

      expect(result.cid).toBe('screenshot');
      expect(result.action).toBe('s3');
      expect(result.buffer).toBe(largeBuffer);
      expect(result.sizeBytes).toBe(15 * 1024);
      expect(result.dataUri).toBeUndefined();
    });

    it('should classify exactly 10KB image for S3 upload (boundary test)', () => {
      const exactBuffer = Buffer.alloc(10 * 1024); // Exactly 10 KB

      const result = service.classifyCidImage(
        'border',
        exactBuffer,
        'image/gif',
      );

      expect(result.action).toBe('s3');
    });

    it('should classify 1-byte image as Base64', () => {
      const tinyBuffer = Buffer.from([0x89]);

      const result = service.classifyCidImage('pixel', tinyBuffer, 'image/png');

      expect(result.action).toBe('base64');
      expect(result.sizeBytes).toBe(1);
    });

    it('should correctly encode buffer to Base64 data URI', () => {
      const testData = Buffer.from('Hello CRM Image');
      const result = service.classifyCidImage('test', testData, 'image/webp');

      expect(result.action).toBe('base64');
      expect(result.dataUri).toBe(
        `data:image/webp;base64,${testData.toString('base64')}`,
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Batch Validation
  // ────────────────────────────────────────────────────────────────────────
  describe('validateAttachmentBatch()', () => {
    it('should pass when all files are safe', () => {
      const files = [
        { fileName: 'report.pdf', sizeBytes: 1000 },
        { fileName: 'photo.jpg', sizeBytes: 5000 },
      ];
      expect(() => service.validateAttachmentBatch(files)).not.toThrow();
    });

    it('should throw BadRequestException when any file is blocked', () => {
      const files = [
        { fileName: 'report.pdf', sizeBytes: 1000 },
        { fileName: 'virus.exe', sizeBytes: 500 },
        { fileName: 'script.bat', sizeBytes: 200 },
      ];

      expect(() => service.validateAttachmentBatch(files)).toThrow(
        BadRequestException,
      );
    });

    it('should include all blocked file names in the error', () => {
      const files = [
        { fileName: 'hack.exe', sizeBytes: 100 },
        { fileName: 'script.ps1', sizeBytes: 200 },
      ];

      try {
        service.validateAttachmentBatch(files);
        fail('Expected BadRequestException');
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const response = (err as BadRequestException).getResponse();
        expect((response as any).blockedFiles).toHaveLength(2);
        expect((response as any).blockedFiles[0]).toContain('hack.exe');
        expect((response as any).blockedFiles[1]).toContain('script.ps1');
      }
    });

    it('should block oversized files in batch', () => {
      const files = [{ fileName: 'huge.zip', sizeBytes: 30 * 1024 * 1024 }];

      expect(() => service.validateAttachmentBatch(files)).toThrow(
        BadRequestException,
      );
    });
  });
});
