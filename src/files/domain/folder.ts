import { ApiProperty } from '@nestjs/swagger';
import { Allow, IsOptional } from 'class-validator';

/**
 * Folder domain entity.
 *
 * Folders are **virtual containers** — they exist only in MongoDB,
 * not in S3. S3 keys remain flat ({tenantId}/{hash}.{ext}).
 * This avoids S3 rename/move complexity entirely.
 */
export class FolderType {
  @ApiProperty({
    type: String,
    example: 'f1a2b3c4-d5e6-7890-abcd-ef1234567890',
  })
  @Allow()
  id: string;

  @ApiProperty()
  tenantId: string;

  @ApiProperty({ example: 'Marketing Assets' })
  name: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Parent folder ID. null = root level.',
  })
  @IsOptional()
  parentId: string | null;

  @ApiProperty({
    example: '/root-id/child-id',
    description: 'Materialized path for efficient tree queries',
  })
  path: string;

  @ApiProperty({
    example: 0,
    description: 'Nesting depth. 0 = root level. Max 5.',
  })
  depth: number;

  @ApiProperty({ description: 'User who created this folder' })
  createdBy: string;

  @ApiProperty({
    example: '#6366f1',
    required: false,
    description: 'UI color accent for folder icon',
  })
  @IsOptional()
  color?: string;

  @ApiProperty({ default: false })
  @IsOptional()
  isDeleted?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  deletedAt?: Date;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
