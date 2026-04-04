import { registerAs } from '@nestjs/config';
import { ReplyWindowConfig } from './reply-window-config.type';
import { IsInt, IsOptional, Min } from 'class-validator';
import validateConfig from '../../utils/validate-config';

class EnvironmentVariablesValidator {
  @IsInt()
  @Min(0)
  @IsOptional()
  OMNI_REPLY_WINDOW_FACEBOOK_HOURS: number;

  @IsInt()
  @Min(0)
  @IsOptional()
  OMNI_REPLY_WINDOW_ZALO_HOURS: number;

  @IsInt()
  @Min(0)
  @IsOptional()
  OMNI_REPLY_WINDOW_WHATSAPP_HOURS: number;

  @IsInt()
  @Min(0)
  @IsOptional()
  OMNI_REPLY_WINDOW_INSTAGRAM_HOURS: number;

  @IsInt()
  @Min(0)
  @IsOptional()
  OMNI_REPLY_WINDOW_LIVECHAT_HOURS: number;
}

export default registerAs<ReplyWindowConfig>('replyWindow', () => {
  validateConfig(process.env, EnvironmentVariablesValidator);

  return {
    facebook: process.env.OMNI_REPLY_WINDOW_FACEBOOK_HOURS
      ? parseInt(process.env.OMNI_REPLY_WINDOW_FACEBOOK_HOURS, 10)
      : 24,
    zalo: process.env.OMNI_REPLY_WINDOW_ZALO_HOURS
      ? parseInt(process.env.OMNI_REPLY_WINDOW_ZALO_HOURS, 10)
      : 24,
    whatsapp: process.env.OMNI_REPLY_WINDOW_WHATSAPP_HOURS
      ? parseInt(process.env.OMNI_REPLY_WINDOW_WHATSAPP_HOURS, 10)
      : 24,
    instagram: process.env.OMNI_REPLY_WINDOW_INSTAGRAM_HOURS
      ? parseInt(process.env.OMNI_REPLY_WINDOW_INSTAGRAM_HOURS, 10)
      : 24,
    livechat: process.env.OMNI_REPLY_WINDOW_LIVECHAT_HOURS
      ? parseInt(process.env.OMNI_REPLY_WINDOW_LIVECHAT_HOURS, 10)
      : 0, // 0 = unlimited — LiveChat is our own channel
  };
});
