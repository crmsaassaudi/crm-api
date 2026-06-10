export enum FileDriver {
  LOCAL = 'local',
  S3 = 's3',
  S3_PRESIGNED = 's3-presigned',
}

export type FileConfig = {
  driver: FileDriver;
  accessKeyId?: string;
  secretAccessKey?: string;
  awsDefaultS3Bucket?: string;
  awsS3Region?: string;
  /** Custom S3-compatible endpoint (e.g. DigitalOcean Spaces) */
  awsS3Endpoint?: string;
  /** Max file size in bytes (default 25 MB) */
  maxFileSize: number;
  /** Max video file size in bytes (default 100 MB) */
  maxVideoSize: number;
};
