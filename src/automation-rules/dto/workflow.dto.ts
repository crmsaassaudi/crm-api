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
import {
  WORKFLOW_RUN_AS_VALUES,
  WorkflowRunAs,
} from '../domain/execution-principal';

export class TriggerConfigDto {
  @ApiProperty({ enum: ['record_created', 'field_updated'] })
  @IsEnum(['record_created', 'field_updated'])
  event: 'record_created' | 'field_updated';

  /**
   * Conversation and Message are included because the engine already supports
   * them end to end — OmniAutomationBridgeService emits
   * `automation.record_created.Conversation` / `.Message`,
   * ActionProcessorMixin.VALID_RECORD_TYPES accepts both, and
   * RouteToGroupExecutor has a dedicated conversation path that goes through the
   * omni AssignmentService. Only this enum (and the execution-log enum) kept
   * them unauthorable, so "Omni Automation" existed everywhere except where a
   * user could switch it on.
   */
  @ApiProperty({
    enum: [
      'Lead',
      'Contact',
      'Ticket',
      'Deal',
      'Account',
      'Task',
      'Conversation',
      'Message',
    ],
  })
  @IsEnum([
    'Lead',
    'Contact',
    'Ticket',
    'Deal',
    'Account',
    'Task',
    'Conversation',
    'Message',
  ])
  object:
    | 'Lead'
    | 'Contact'
    | 'Ticket'
    | 'Deal'
    | 'Account'
    | 'Task'
    | 'Conversation'
    | 'Message';

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
