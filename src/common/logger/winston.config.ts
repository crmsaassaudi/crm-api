import {
  utilities as nestWinstonUtilities,
  WinstonModuleOptions,
} from 'nest-winston';
import * as winston from 'winston';
import { ClsService } from 'nestjs-cls';

export const winstonConfig = (clsService: ClsService): WinstonModuleOptions => {
  return {
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.ms(),
          nestWinstonUtilities.format.nestLike('MyApp', {
            colors: true,
            prettyPrint: true,
          }),
          winston.format.printf(
            ({ context, level, timestamp, message, ms, ...meta }) => {
              const correlationId = clsService.getId() || 'N/A';

              const metaString = Object.keys(meta).length
                ? JSON.stringify(meta)
                : '';

              return `[${timestamp}] [${correlationId}] ${level} [${context}] : ${message} ${ms} ${metaString}`;
            },
          ),
        ),
      }),
      // Add File transport if needed, e.g.:
      // new winston.transports.File({ filename: 'error.log', level: 'error' }),
      // new winston.transports.File({ filename: 'combined.log' }),
    ],
  };
};
