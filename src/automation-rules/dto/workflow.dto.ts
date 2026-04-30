import {
  IsString,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsArray,
  IsNumber,
  IsDateString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';

export class TriggerConfigDto {
  @ApiProperty({ enum: ['record_created', 'field_updated'] })
  @IsEnum(['record_created', 'field_updated'])
  event: 'record_created' | 'field_updated';

  @ApiProperty({
    enum: ['Lead', 'Contact', 'Ticket', 'Deal', 'Account', 'Task'],
  })
  @IsEnum(['Lead', 'Contact', 'Ticket', 'Deal', 'Account', 'Task'])
  object: 'Lead' | 'Contact' | 'Ticket' | 'Deal' | 'Account' | 'Task';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  field?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  runOncePerRecord?: boolean;
}

export class WorkflowNodeDto {
  @ApiProperty()
  @IsString()
  id: string;

  @ApiProperty()
  @IsString()
  type: string;

  @ApiProperty()
  position: { x: number; y: number };

  @ApiPropertyOptional()
  @IsOptional()
  config?: Record<string, any>;
}

export class WorkflowEdgeDto {
  @ApiProperty()
  @IsString()
  id: string;

  @ApiProperty()
  @IsString()
  source: string;

  @ApiProperty()
  @IsString()
  target: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sourceHandle?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  targetHandle?: string | null;
}

export class ViewportDto {
  @ApiProperty()
  @IsNumber()
  x: number;

  @ApiProperty()
  @IsNumber()
  y: number;

  @ApiProperty()
  @IsNumber()
  zoom: number;
}

export class CreateWorkflowDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ type: TriggerConfigDto })
  @ValidateNested()
  @Type(() => TriggerConfigDto)
  triggerConfig: TriggerConfigDto;

  @ApiProperty({ type: [WorkflowNodeDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkflowNodeDto)
  nodes: WorkflowNodeDto[];

  @ApiProperty({ type: [WorkflowEdgeDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkflowEdgeDto)
  edges: WorkflowEdgeDto[];

  @ApiPropertyOptional({ type: ViewportDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ViewportDto)
  viewport?: ViewportDto;
}

export class UpdateWorkflowDto extends PartialType(CreateWorkflowDto) {
  @ApiPropertyOptional({
    description:
      'For optimistic concurrency control. If provided, the server verifies this matches the DB value before updating.',
  })
  @IsOptional()
  @IsDateString()
  updatedAt?: string;
}

export class UpdateWorkflowStatusDto {
  @ApiProperty({ enum: ['draft', 'active', 'paused'] })
  @IsEnum(['draft', 'active', 'paused'])
  status: 'draft' | 'active' | 'paused';
}

export class RetryStepDto {
  @ApiProperty({ description: 'The node ID of the failed step to retry' })
  @IsString()
  nodeId: string;
}
