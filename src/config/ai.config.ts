import { registerAs } from '@nestjs/config';
import { AiConfig } from './ai-config.type';
import validateConfig from '.././utils/validate-config';
import { IsOptional, IsString } from 'class-validator';

class EnvironmentVariablesValidator {
  @IsString()
  @IsOptional()
  OPENAI_API_KEY?: string;

  @IsString()
  @IsOptional()
  GEMINI_API_KEY?: string;
}

export default registerAs<AiConfig>('ai', () => {
  validateConfig(process.env, EnvironmentVariablesValidator);

  return {
    openaiApiKey: process.env.OPENAI_API_KEY,
    geminiApiKey: process.env.GEMINI_API_KEY,
  };
});
