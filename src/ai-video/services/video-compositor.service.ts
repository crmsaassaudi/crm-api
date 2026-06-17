import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { AiVideoSettingsRepository } from '../repositories/ai-video-settings.repository';

const execFileAsync = promisify(execFile);

export interface RenderOptions {
  jobId: string;
  scriptText: string;
  voiceAudioBuffer: Buffer;
  backgroundImageUrl?: string;
  bgmUrl?: string;
}

@Injectable()
export class VideoCompositorService {
  private readonly logger = new Logger(VideoCompositorService.name);

  constructor(private readonly settingsRepository: AiVideoSettingsRepository) {}

  async renderVideo(tenantId: string, options: RenderOptions): Promise<string> {
    const settings = await this.settingsRepository.findByTenantId(tenantId);
    // Validate bgmVolume is a finite number in [0, 1] to prevent FFmpeg
    // filter-graph injection via crafted database values (e.g. "0[bgm];[voice]anull[a]").
    const rawVolume = Number(settings?.bgmVolume ?? 0.15);
    const bgmVolume = Number.isFinite(rawVolume)
      ? Math.max(0, Math.min(1, rawVolume))
      : 0.15;
    const tempDir = path.join('/tmp', 'crm-render', tenantId);
    fs.mkdirSync(tempDir, { recursive: true });
    fs.mkdirSync(path.join(process.cwd(), 'files'), { recursive: true });

    const voiceAudioPath = path.join(tempDir, `${options.jobId}_voice.mp3`);
    const outputVideoPath = path.join(
      process.cwd(),
      'files',
      `ai-video-${options.jobId}.mp4`,
    );

    fs.writeFileSync(voiceAudioPath, options.voiceAudioBuffer);

    const bgImagePath = this.resolveBackgroundImage(tempDir);
    const bgmPath = this.resolveBgmPath();

    // LOW-13: Use execFile instead of exec to prevent shell injection.
    // exec() spawns a shell — a filename containing `;rm -rf /` would execute.
    await execFileAsync('ffmpeg', ['-version']);

    const baseArgs = [
      '-y',
      '-loop',
      '1',
      '-i',
      bgImagePath,
      '-i',
      voiceAudioPath,
    ];

    let ffmpegArgs: string[];
    if (bgmPath) {
      ffmpegArgs = [
        ...baseArgs,
        '-stream_loop',
        '-1',
        '-i',
        bgmPath,
        '-filter_complex',
        `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[v];[1:a]volume=1.0[voice];[2:a]volume=${bgmVolume}[bgm];[voice][bgm]amix=inputs=2:duration=first[a]`,
        '-map',
        '[v]',
        '-map',
        '[a]',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        outputVideoPath,
      ];
    } else {
      ffmpegArgs = [
        ...baseArgs,
        '-filter_complex',
        '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[v]',
        '-map',
        '[v]',
        '-map',
        '1:a',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        outputVideoPath,
      ];
    }

    this.logger.log(`Executing FFmpeg render for AI video ${options.jobId}`);
    await execFileAsync('ffmpeg', ffmpegArgs);
    return outputVideoPath;
  }

  private resolveBackgroundImage(tempDir: string): string {
    const envBgSlide = process.env.BG_SLIDE_PATH;
    if (envBgSlide && fs.existsSync(envBgSlide)) {
      return envBgSlide;
    }

    const bgImagePath = path.join(tempDir, 'default_bg.jpg');
    if (!fs.existsSync(bgImagePath)) {
      const dummyJpgHex =
        'ffd8ffe000104a46494600010101006000600000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501110101010100000000000000000102030405060708090a0bffc400b1100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aaabacadaeafb2b3b4b5b6b7b8b9babbbcbdbebfc2c3c4c5c6c7c8c9cacecdcecfffd9';
      fs.writeFileSync(bgImagePath, Buffer.from(dummyJpgHex, 'hex'));
    }
    return bgImagePath;
  }

  private resolveBgmPath(): string | null {
    const envBgm = process.env.BGM_PATH;
    return envBgm && fs.existsSync(envBgm) ? envBgm : null;
  }
}
