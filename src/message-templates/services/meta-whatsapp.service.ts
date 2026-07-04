import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import FormData from 'form-data';

@Injectable()
export class MetaWhatsAppService {
  private readonly logger = new Logger(MetaWhatsAppService.name);
  private readonly apiVersion = 'v20.0';

  constructor(private readonly configService: ConfigService) {}

  private getCredentials() {
    const accessToken =
      this.configService.get<string>('META_ACCESS_TOKEN', { infer: true }) ||
      process.env.META_ACCESS_TOKEN;
    const wabaId =
      this.configService.get<string>('META_WHATSAPP_BUSINESS_ACCOUNT_ID', {
        infer: true,
      }) || process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID;
    const phoneNumberId =
      this.configService.get<string>('META_PHONE_NUMBER_ID', { infer: true }) ||
      process.env.META_PHONE_NUMBER_ID;
    return { accessToken, wabaId, phoneNumberId };
  }

  async createTemplate(
    name: string,
    category: string,
    language: string,
    components: any[],
  ): Promise<{ metaTemplateId: string; status: string }> {
    const { accessToken, wabaId } = this.getCredentials();

    if (!accessToken || !wabaId) {
      this.logger.warn(
        `Meta credentials not configured. Mocking success for template: ${name}`,
      );
      return {
        metaTemplateId: `mock_meta_id_${Math.random().toString(36).substring(7)}`,
        status: 'PENDING',
      };
    }

    try {
      const response = await axios.post(
        `https://graph.facebook.com/${this.apiVersion}/${wabaId}/message_templates`,
        {
          name,
          category,
          language,
          components,
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        },
      );

      return {
        metaTemplateId: response.data.id,
        status: response.data.status || 'PENDING',
      };
    } catch (error: any) {
      this.logger.error(
        `Error creating template on Meta: ${error.response?.data?.error?.message || error.message}`,
      );
      throw error;
    }
  }

  async deleteTemplate(name: string): Promise<boolean> {
    const { accessToken, wabaId } = this.getCredentials();

    if (!accessToken || !wabaId) {
      this.logger.warn(
        `Meta credentials not configured. Mocking template deletion: ${name}`,
      );
      return true;
    }

    try {
      await axios.delete(
        `https://graph.facebook.com/${this.apiVersion}/${wabaId}/message_templates`,
        {
          params: {
            name,
          },
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );
      return true;
    } catch (error: any) {
      this.logger.error(
        `Error deleting template on Meta: ${error.response?.data?.error?.message || error.message}`,
      );
      throw error;
    }
  }

  async fetchTemplates(): Promise<any[]> {
    const { accessToken, wabaId } = this.getCredentials();

    if (!accessToken || !wabaId) {
      this.logger.warn(
        'Meta credentials not configured. Returning empty templates sync list.',
      );
      return [];
    }

    try {
      const response = await axios.get(
        `https://graph.facebook.com/${this.apiVersion}/${wabaId}/message_templates`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );
      return response.data.data || [];
    } catch (error: any) {
      this.logger.error(
        `Error fetching templates from Meta: ${error.response?.data?.error?.message || error.message}`,
      );
      throw error;
    }
  }

  async uploadMedia(
    fileBuffer: Buffer,
    filename: string,
    mimeType: string,
  ): Promise<string> {
    const { accessToken, phoneNumberId } = this.getCredentials();

    if (!accessToken || !phoneNumberId) {
      this.logger.warn(
        'Meta credentials not configured. Mocking media upload.',
      );
      return `mock_media_id_${Math.random().toString(36).substring(7)}`;
    }

    try {
      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('file', fileBuffer, {
        filename: filename,
        contentType: mimeType,
      });

      const response = await axios.post(
        `https://graph.facebook.com/${this.apiVersion}/${phoneNumberId}/media`,
        form,
        {
          headers: {
            ...form.getHeaders(),
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );

      return response.data.id;
    } catch (error: any) {
      this.logger.error(
        `Error uploading media to Meta: ${error.response?.data?.error?.message || error.message}`,
      );
      throw error;
    }
  }
}
