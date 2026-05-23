import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AllConfigType } from '../../config/config.type';

@Injectable()
export class AiGeneratorService {
  private readonly logger = new Logger(AiGeneratorService.name);

  constructor(private readonly configService: ConfigService<AllConfigType>) {}

  async generateCaptionAndHashtags(
    videoUrl: string,
    userPrompt?: string,
    existingCaption?: string,
  ): Promise<{ caption: string; hashtags: string[] }> {
    const openaiApiKey = this.configService.get('ai.openaiApiKey', {
      infer: true,
    });
    const geminiApiKey = this.configService.get('ai.geminiApiKey', {
      infer: true,
    });
    const contextText = `
      Video URL: ${videoUrl}
      User Input Prompt: ${userPrompt || 'None'}
      Existing Draft Caption: ${existingCaption || 'None'}
    `;

    if (geminiApiKey) {
      try {
        this.logger.log('Gemini API key detected. Generating metadata...');
        const response = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`,
          {
            contents: [
              {
                parts: [
                  {
                    text: `Generate a concise video caption and 5-8 relevant hashtags. Respond only as JSON: {"caption": "...", "hashtags": ["h1", "h2"]}. Context: ${contextText}`,
                  },
                ],
              },
            ],
          },
        );

        const responseText =
          response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (responseText) {
          return this.parseMetadataResponse(responseText);
        }
      } catch (error: any) {
        this.logger.error(
          `Gemini metadata generation failed: ${error.message}`,
        );
      }
    }

    if (openaiApiKey) {
      try {
        this.logger.log('OpenAI API key detected. Generating metadata...');
        const response = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: 'gpt-4o-mini',
            messages: [
              {
                role: 'system',
                content:
                  'Respond only with a raw JSON object: {"caption": "caption", "hashtags": ["h1", "h2"]}.',
              },
              {
                role: 'user',
                content: `Generate social media video caption and hashtags for this context: ${contextText}`,
              },
            ],
            response_format: { type: 'json_object' },
          },
          {
            headers: {
              Authorization: `Bearer ${openaiApiKey}`,
              'Content-Type': 'application/json',
            },
          },
        );

        const responseText = response.data?.choices?.[0]?.message?.content;
        if (responseText) {
          return this.parseMetadataResponse(responseText);
        }
      } catch (error: any) {
        this.logger.error(
          `OpenAI metadata generation failed: ${error.message}`,
        );
      }
    }

    throw new BadRequestException(
      'No working AI metadata provider is configured for AI video.',
    );
  }

  private parseMetadataResponse(responseText: string): {
    caption: string;
    hashtags: string[];
  } {
    const parsed = JSON.parse(responseText.replace(/```json|```/g, '').trim());
    if (!parsed.caption || !Array.isArray(parsed.hashtags)) {
      throw new BadRequestException('AI metadata response is invalid.');
    }

    return {
      caption: parsed.caption,
      hashtags: parsed.hashtags.map((hashtag: string) =>
        hashtag.replace('#', ''),
      ),
    };
  }
}
