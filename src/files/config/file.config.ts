import { registerAs } from '@nestjs/config';

import { IsEnum, IsOptional, IsString, ValidateIf } from 'class-validator';
import validateConfig from '../../utils/validate-config';
import { FileDriver, FileConfig } from './file-config.type';

class EnvironmentVariablesValidator {
  @IsEnum(FileDriver)
  FILE_DRIVER: FileDriver;

  @ValidateIf((envValues) =>
    [FileDriver.S3, FileDriver.S3_PRESIGNED].includes(envValues.FILE_DRIVER),
  )
  @IsString()
  ACCESS_KEY_ID: string;

  @ValidateIf((envValues) =>
    [FileDriver.S3, FileDriver.S3_PRESIGNED].includes(envValues.FILE_DRIVER),
  )
  @IsString()
  SECRET_ACCESS_KEY: string;

  @ValidateIf((envValues) =>
    [FileDriver.S3, FileDriver.S3_PRESIGNED].includes(envValues.FILE_DRIVER),
  )
  @IsString()
  AWS_DEFAULT_S3_BUCKET: string;

  @ValidateIf((envValues) =>
    [FileDriver.S3, FileDriver.S3_PRESIGNED].includes(envValues.FILE_DRIVER),
  )
  @IsString()
  AWS_S3_REGION: string;

  @ValidateIf((envValues) =>
    [FileDriver.S3, FileDriver.S3_PRESIGNED].includes(envValues.FILE_DRIVER),
  )
  @IsOptional()
  @IsString()
  AWS_S3_ENDPOINT: string;
}

export default registerAs<FileConfig>('file', () => {
  const config = {
    ...process.env,
    FILE_DRIVER: process.env.FILE_DRIVER ?? FileDriver.LOCAL,
  };

  validateConfig(config, EnvironmentVariablesValidator);

  return {
    driver: config.FILE_DRIVER as FileDriver,
    accessKeyId: process.env.ACCESS_KEY_ID,
    secretAccessKey: process.env.SECRET_ACCESS_KEY,
    awsDefaultS3Bucket: process.env.AWS_DEFAULT_S3_BUCKET,
    awsS3Region: process.env.AWS_S3_REGION,
    awsS3Endpoint: process.env.AWS_S3_ENDPOINT,
    maxFileSize: 26_214_400, // 25 MB
    maxVideoSize: 104_857_600, // 100 MB
  };
});

