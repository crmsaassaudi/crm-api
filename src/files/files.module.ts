import {
  // common
  Module,
  forwardRef,
} from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { MongooseModule } from '@nestjs/mongoose';
import * as multer from 'multer';

import { DocumentFilePersistenceModule } from './infrastructure/persistence/document/document-persistence.module';
import { FilesService } from './files.service';
import { ImageProcessingService } from './image-processing.service';
import { FolderService } from './folder.service';
import { FileManagementController } from './file-management.controller';
import { FolderController } from './folder.controller';
import { FolderDocumentRepository } from './infrastructure/persistence/document/repositories/folder.repository';
import {
  FolderSchemaClass,
  FolderSchema,
} from './infrastructure/persistence/document/entities/folder.schema';
import fileConfig from './config/file.config';
import { FileConfig, FileDriver } from './config/file-config.type';
import { FilesLocalModule } from './infrastructure/uploader/local/files.module';
import { FilesS3Module } from './infrastructure/uploader/s3/files.module';
import { FilesS3PresignedModule } from './infrastructure/uploader/s3-presigned/files.module';
import { TenantsModule } from '../tenants/tenants.module';
import { RedisModule } from '../redis/redis.module';

const infrastructurePersistenceModule = DocumentFilePersistenceModule;

const infrastructureUploaderModule =
  (fileConfig() as FileConfig).driver === FileDriver.LOCAL
    ? FilesLocalModule
    : (fileConfig() as FileConfig).driver === FileDriver.S3
      ? FilesS3Module
      : FilesS3PresignedModule;

@Module({
  imports: [
    // Persistence layer
    infrastructurePersistenceModule,
    // Legacy uploader (presigned URL flow)
    infrastructureUploaderModule,
    // Folder schema
    MongooseModule.forFeature([
      { name: FolderSchemaClass.name, schema: FolderSchema },
    ]),
    // In-memory multer for the new direct upload endpoint
    MulterModule.register({
      storage: multer.memoryStorage(),
      limits: {
        fileSize: (fileConfig() as FileConfig).maxFileSize || 26214400, // 25 MB
      },
    }),
    // TenantsModule for quota management
    forwardRef(() => TenantsModule),
    // Redis for distributed presigned URL caching
    RedisModule,
  ],
  providers: [
    FilesService,
    ImageProcessingService,
    FolderService,
    FolderDocumentRepository,
  ],
  controllers: [FileManagementController, FolderController],
  exports: [
    FilesService,
    ImageProcessingService,
    FolderService,
    infrastructurePersistenceModule,
  ],
})
export class FilesModule {}
