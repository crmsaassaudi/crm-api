import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AllConfigType } from '../../config/config.type';
import { AiVideoSettingsRepository } from '../repositories/ai-video-settings.repository';
import axios from 'axios';

@Injectable()
export class VoiceSynthesisService {
  private readonly logger = new Logger(VoiceSynthesisService.name);

  constructor(
    private readonly settingsRepository: AiVideoSettingsRepository,
    private readonly configService: ConfigService<AllConfigType>,
  ) {}

  /**
   * Synthesizes script text to MP3 audio using configured TTS providers.
   * Returns audio buffer.
   */
  async synthesizeSpeech(
    tenantId: string,
    text: string,
    voiceIdOverride?: string,
  ): Promise<Buffer> {
    if (!text || text.trim() === '') {
      throw new BadRequestException('Script text is required.');
    }

    // 1. Fetch Tenant Settings for ElevenLabs details
    const settings = await this.settingsRepository.findByTenantId(tenantId);
    const elevenLabsApiKey = settings?.elevenLabsApiKey;
    const voiceId =
      voiceIdOverride || settings?.defaultVoiceId || '21m00Tcm4TlvDq8ikWAM'; // Rachel

    if (elevenLabsApiKey) {
      try {
        this.logger.log(
          `Invoking ElevenLabs TTS for tenant ${tenantId} using voice ${voiceId}...`,
        );
        const response = await axios.post(
          `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
          {
            text: text,
            model_id: 'eleven_multilingual_v2',
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75,
            },
          },
          {
            headers: {
              'xi-api-key': elevenLabsApiKey,
              'Content-Type': 'application/json',
            },
            responseType: 'arraybuffer',
          },
        );

        if (response.data) {
          this.logger.log('ElevenLabs voice synthesis completed successfully.');
          return Buffer.from(response.data);
        }
      } catch (err: any) {
        this.logger.error(`ElevenLabs TTS failed: ${err.message}.`);
      }
    }

    const openaiApiKey = this.configService.get('ai.openaiApiKey', {
      infer: true,
    });
    if (openaiApiKey) {
      try {
        this.logger.log('OpenAI API Key detected. Invoking OpenAI TTS...');
        const response = await axios.post(
          'https://api.openai.com/v1/audio/speech',
          {
            model: 'tts-1',
            input: text,
            voice: 'alloy', // alloy, echo, fable, onyx, nova, shimmer
          },
          {
            headers: {
              Authorization: `Bearer ${openaiApiKey}`,
              'Content-Type': 'application/json',
            },
            responseType: 'arraybuffer',
          },
        );

        if (response.data) {
          this.logger.log('OpenAI TTS completed successfully.');
          return Buffer.from(response.data);
        }
      } catch (err: any) {
        this.logger.error(`OpenAI TTS failed: ${err.message}.`);
      }
    }

    throw new BadRequestException(
      'No working TTS provider is configured for AI video generation.',
    );
  }
}
