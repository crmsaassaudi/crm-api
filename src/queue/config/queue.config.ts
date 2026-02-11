import { registerAs } from '@nestjs/config';
import { QueueConfig } from './queue-config.type';
import { IsInt, IsOptional, IsString, Min, Max } from 'class-validator';
import validateConfig from '../../utils/validate-config';

class EnvironmentVariablesValidator {
    @IsString()
    @IsOptional()
    REDIS_HOST: string;

    @IsInt()
    @Min(0)
    @Max(65535)
    @IsOptional()
    REDIS_PORT: number;

    @IsString()
    @IsOptional()
    REDIS_PASSWORD: string;

    @IsInt()
    @IsOptional()
    REDIS_DB: number;

    @IsString()
    @IsOptional()
    REDIS_URL: string;
}

export default registerAs<QueueConfig>('queue', () => {
    validateConfig(process.env, EnvironmentVariablesValidator);

    return {
        url: process.env.REDIS_URL,
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : 6379,
        password: process.env.REDIS_PASSWORD,
        db: process.env.REDIS_DB ? parseInt(process.env.REDIS_DB, 10) : 0,
    };
});
