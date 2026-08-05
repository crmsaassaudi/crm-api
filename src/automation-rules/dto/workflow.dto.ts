import {
  IsString,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsArray,
  IsNumber,
  IsDateString,
  IsObject,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  WORKFLOW_RUN_AS_VALUES,
  WorkflowRunAs,
} from '../domain/execution-principal';
import {
  AUTOMATION_TRIGGER_EVENTS,
  AUTOMATION_TRIGGER_OBJECTS,
  AutomationTriggerEvent,
} from '../domain/trigger-catalog';
import { AutomationCrmModule } from '../events/automation-event.payload';

export class TriggerConfigDto {
  @ApiProperty({ enum: AUTOMATION_TRIGGER_EVENTS as unknown as string[] })
  @IsEnum(AUTOMATION_TRIGGER_EVENTS as unknown as string[])
  event: AutomationTriggerEvent;

  @ApiProperty({ enum: AUTOMATION_TRIGGER_OBJECTS as unknown as string[] })
  @IsEnum(AUTOMATION_TRIGGER_OBJECTS as unknown as string[])
  object: AutomationCrmModule;

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

  /**
   * Which principal the workflow's actions execute as.
   *
   * Omitted means `system` — full tenant scope — which is what every workflow
   * did before this field existed. Choosing `system` explicitly requires
   * `automation_workflows:run_as_system`.
   */
  @ApiPropertyOptional({
    enum: WORKFLOW_RUN_AS_VALUES as unknown as string[],
    description:
      'Principal the workflow executes as. Defaults to system (full tenant scope).',
  })
  @IsOptional()
  @IsEnum(WORKFLOW_RUN_AS_VALUES as unknown as string[])
  runAs?: WorkflowRunAs;

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

/**
 * Input for a dry run.
 *
 * One of the two must be present. `recordId` is strongly preferred: conditions
 * and templates only tell the truth against the shape of data the workflow will
 * actually see.
 */
export class DryRunWorkflowDto {
  @ApiPropertyOptional({
    description:
      'Id of an existing record of the trigger object to test against. ' +
      'Read with the caller’s own visibility.',
  })
  @IsOptional()
  @IsString()
  recordId?: string;

  @ApiPropertyOptional({
    description:
      'Field values to test with when no suitable record exists yet. ' +
      'Ignored if recordId is supplied.',
  })
  @IsOptional()
  @IsObject()
  sampleData?: Record<string, any>;
}
