import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AllConfigType } from '../../config/config.type';
import axios from 'axios';

@Injectable()
export class AiGeneratorService {
  private readonly logger = new Logger(AiGeneratorService.name);

  constructor(private readonly configService: ConfigService<AllConfigType>) {}

  /**
   * Automatically generates high-converting caption and SEO-optimized hashtags
   * using OpenAI, Gemini or a smart heuristic rule-based AI engine fallback.
   */
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

    // 1. Try Gemini API first (if key configured)
    if (geminiApiKey) {
      try {
        this.logger.log(
          'Gemini API Key detected. Fetching caption from Gemini Pro...',
        );
        const response = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`,
          {
            contents: [
              {
                parts: [
                  {
                    text: `You are an expert social media manager and content creator. Generate a highly engaging, SEO-optimized, click-worthy video caption (under 250 words) and a list of 5-8 relevant trending hashtags for a vertical Reels/TikTok video based on the following context. Respond in clean JSON format: {"caption": "...", "hashtags": ["hashtag1", "hashtag2"]}. Do not include markdown wraps or code blocks. Context: ${contextText}`,
                  },
                ],
              },
            ],
          },
        );

        const responseText =
          response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (responseText) {
          const parsed = JSON.parse(
            responseText.replace(/```json|```/g, '').trim(),
          );
          if (parsed.caption && Array.isArray(parsed.hashtags)) {
            return {
              caption: parsed.caption,
              hashtags: parsed.hashtags.map((h: string) => h.replace('#', '')),
            };
          }
        }
      } catch (err: any) {
        this.logger.error(
          `Gemini generation failed: ${err.message}. Falling back...`,
        );
      }
    }

    // 2. Try OpenAI API (if key configured)
    if (openaiApiKey) {
      try {
        this.logger.log(
          'OpenAI API Key detected. Fetching caption from GPT-4o-mini...',
        );
        const response = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: 'gpt-4o-mini',
            messages: [
              {
                role: 'system',
                content:
                  'You are an expert social media manager. Respond only with a raw JSON object: {"caption": "your caption", "hashtags": ["h1", "h2"]}',
              },
              {
                role: 'user',
                content: `Generate social media Reels caption and hashtags for this content context: ${contextText}`,
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
          const parsed = JSON.parse(responseText.trim());
          if (parsed.caption && Array.isArray(parsed.hashtags)) {
            return {
              caption: parsed.caption,
              hashtags: parsed.hashtags.map((h: string) => h.replace('#', '')),
            };
          }
        }
      } catch (err: any) {
        this.logger.error(
          `OpenAI generation failed: ${err.message}. Falling back...`,
        );
      }
    }

    // 3. Smart Heuristic Rule-Based AI Engine Fallback (Resilient offline generation)
    this.logger.log('Running heuristic AI Content Engine fallback...');
    return this.runHeuristicGenerator(
      userPrompt || existingCaption || videoUrl,
    );
  }

  private runHeuristicGenerator(seedText: string): {
    caption: string;
    hashtags: string[];
  } {
    const text = seedText.toLowerCase();

    // Context analysis
    let niche = 'general';
    if (
      text.includes('crm') ||
      text.includes('customer') ||
      text.includes('client') ||
      text.includes('quản lý')
    ) {
      niche = 'crm';
    } else if (
      text.includes('sale') ||
      text.includes('bán hàng') ||
      text.includes('chốt đơn') ||
      text.includes('revenue')
    ) {
      niche = 'sales';
    } else if (
      text.includes('marketing') ||
      text.includes('ads') ||
      text.includes('quảng cáo') ||
      text.includes('funnel')
    ) {
      niche = 'marketing';
    } else if (
      text.includes('tech') ||
      text.includes('automation') ||
      text.includes('tự động hóa') ||
      text.includes('software')
    ) {
      niche = 'technology';
    } else if (
      text.includes('tutorial') ||
      text.includes('hướng dẫn') ||
      text.includes('tips') ||
      text.includes('làm thế nào')
    ) {
      niche = 'educational';
    }

    const templates: Record<
      string,
      Array<{ caption: string; hashtags: string[] }>
    > = {
      crm: [
        {
          caption:
            '🚀 Bạn có đang tốn quá nhiều thời gian để quản lý thông tin khách hàng thủ công? Hãy để hệ thống CRM tự động hóa toàn bộ quy trình chăm sóc khách hàng của bạn! Từ quản lý phễu leads, gửi email tự động cho đến phân tích hành vi khách hàng một cách chi tiết nhất. Xem video ngay để thấy sự khác biệt vượt trội! 💡✨',
          hashtags: [
            'CRM',
            'CustomerRelationship',
            'CustomerCare',
            'BusinessAutomation',
            'WorkSmart',
            'DigitalTransformation',
          ],
        },
        {
          caption:
            '🔥 Bí quyết giữ chân 99% khách hàng trung thành nằm ở đây! Hệ thống CRM thế hệ mới giúp doanh nghiệp của bạn thấu hiểu khách hàng sâu sắc, tối ưu hóa dịch vụ và tăng trưởng doanh thu vượt bậc. Click xem ngay giải pháp đột phá này! 📈🤝',
          hashtags: [
            'CRMSoftware',
            'RetentionRate',
            'ClientRelations',
            'ProductivityHacks',
            'StartupLife',
            'ScaleBusiness',
          ],
        },
      ],
      sales: [
        {
          caption:
            '💰 5 Bước đột phá doanh số bán hàng tự động mà các triệu phú không muốn bạn biết! Áp dụng ngay hệ thống phễu bán hàng thông minh và quy trình chốt đơn tự động để nhân 3 hiệu suất bán hàng của đội ngũ ngay hôm nay. Xem hết video nhé! 👇💵',
          hashtags: [
            'SalesFunnel',
            'SalesTips',
            'RevenueGrowth',
            'AutomationSales',
            'ClosingDeals',
            'BusinessSuccess',
          ],
        },
        {
          caption:
            '⚡ Biến leads lạnh thành khách hàng chốt đơn rầm rộ chỉ trong 7 ngày! Đừng bỏ lỡ quy trình tối ưu hóa chuyển đổi cực kỳ thực tế này. Hãy xem kỹ và áp dụng ngay cho doanh nghiệp của bạn! 🚀🎯',
          hashtags: [
            'LeadConversion',
            'SalesStrategy',
            'EntrepreneurTips',
            'SalesCoach',
            'AutomatedIncome',
            'GrowthHacking',
          ],
        },
      ],
      marketing: [
        {
          caption:
            '🎯 Tối ưu hóa chi phí quảng cáo (ROAS) lên gấp 5 lần với kỹ thuật phân tích tệp khách hàng tự động! Khám phá cách các thương hiệu lớn đang ứng dụng AI để cá nhân hóa chiến dịch marketing cực kỳ đỉnh cao. Xem ngay! 🌟📊',
          hashtags: [
            'DigitalMarketing',
            'ROASOptimization',
            'AIMarketing',
            'AdCampaign',
            'AudienceTargeting',
            'GrowthMindset',
          ],
        },
        {
          caption:
            '💡 Xu hướng Marketing tự động hóa đang dẫn đầu kỷ nguyên số! Làm thế nào để xây dựng một phễu thu hút khách hàng tiềm năng đa kênh hoàn toàn tự động mà không tốn chi phí nhân sự? Tất cả có trong video này! 🌐🔥',
          hashtags: [
            'MarketingAutomation',
            'OmnichannelMarketing',
            'LeadGeneration',
            'BrandStrategy',
            'SocialMediaTips',
            'MarketingTrends',
          ],
        },
      ],
      technology: [
        {
          caption:
            '🤖 Tự động hóa mọi tác vụ lặp đi lặp lại trong doanh nghiệp của bạn chỉ với 1 click! Ứng dụng công nghệ Low-code/No-code kết hợp với Trí tuệ nhân tạo (AI) để giải phóng sức lao động và tối ưu hóa chi phí vận hành đến 80%. Xem chi tiết tại đây! 💻🚀',
          hashtags: [
            'AIAutomation',
            'NoCodeLowCode',
            'FutureOfWork',
            'TechInnovation',
            'BusinessEfficiency',
            'DeveloperCommunity',
          ],
        },
      ],
      educational: [
        {
          caption:
            '📚 Hướng dẫn chi tiết từng bước (A-Z) giúp bạn làm chủ hệ thống vận hành tự động ngay tại nhà! Phù hợp cho cả người mới bắt đầu và các chủ doanh nghiệp đang muốn số hóa quy trình kinh doanh. Đừng quên lưu lại video hữu ích này nhé! 💾💡',
          hashtags: [
            'Tutorial',
            'HowToScale',
            'LearnTech',
            'SelfImprovement',
            'DigitalSkills',
            'Elearning',
          ],
        },
      ],
      general: [
        {
          caption:
            '✨ Đột phá năng suất làm việc và thay đổi hoàn toàn cách vận hành kinh doanh truyền thống của bạn! Video ngắn này sẽ mang lại cho bạn những góc nhìn hoàn toàn mới về kỷ nguyên số và công nghệ tự động hóa. Đừng bỏ lỡ! 🚀🌟',
          hashtags: [
            'Productivity',
            'BusinessUpgrade',
            'TechTrends',
            'WorkSmarter',
            'Innovation',
            'MotivateDaily',
          ],
        },
      ],
    };

    const selectedTemplates = templates[niche] || templates.general;
    // Pick a random template from the selected niche
    const randomIndex = Math.floor(Math.random() * selectedTemplates.length);
    return selectedTemplates[randomIndex];
  }
}
