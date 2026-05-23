import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../common/permissions/permission.decorator';
import {
  CreateSocialPostDto,
  ListSocialPostTasksQueryDto,
  ListSocialPostsQueryDto,
  RejectSocialPostDto,
  ScheduleSocialPostDto,
  UpdateSocialPostDto,
} from './dto/social-post.dto';
import { SocialPostsService } from './services/social-posts.service';

@ApiTags('Social Posts')
@Controller({
  path: 'social-posts',
  version: '1',
})
export class SocialPostsController {
  constructor(private readonly socialPostsService: SocialPostsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a social post draft or scheduled post' })
  @RequirePermission('create', 'social_posts')
  async create(@Body() dto: CreateSocialPostDto) {
    return this.socialPostsService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List social posts for the current tenant' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'approvalStatus', required: false, type: String })
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  @RequirePermission('view', 'social_posts')
  async list(@Query() query: ListSocialPostsQueryDto) {
    return this.socialPostsService.findPaginated(query);
  }

  @Get('tasks')
  @ApiOperation({ summary: 'List social post publish tasks' })
  @RequirePermission('view', 'social_posts')
  async listTasks(@Query() query: ListSocialPostTasksQueryDto) {
    return this.socialPostsService.listTasks(query);
  }

  @Post('tasks/:taskId/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retry a failed publish task' })
  @RequirePermission('edit', 'social_posts')
  async retryTask(@Param('taskId') taskId: string) {
    return this.socialPostsService.retryTask(taskId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a social post with channel tasks' })
  @RequirePermission('view', 'social_posts')
  async findOne(@Param('id') id: string) {
    return this.socialPostsService.findById(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a social post draft or scheduled post' })
  @RequirePermission('edit', 'social_posts')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateSocialPostDto,
  ) {
    return this.socialPostsService.update(id, dto);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a social post for publishing' })
  @RequirePermission('manage_system', 'social_posts')
  async approve(@Param('id') id: string) {
    return this.socialPostsService.approve(id);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a social post' })
  @RequirePermission('manage_system', 'social_posts')
  async reject(
    @Param('id') id: string,
    @Body() dto: RejectSocialPostDto,
  ) {
    return this.socialPostsService.reject(id, dto);
  }

  @Post(':id/schedule')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Schedule or reschedule a social post' })
  @RequirePermission('edit', 'social_posts')
  async schedule(
    @Param('id') id: string,
    @Body() dto: ScheduleSocialPostDto,
  ) {
    return this.socialPostsService.schedule(id, dto);
  }

  @Post(':id/publish-now')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Immediately publish an approved social post' })
  @RequirePermission('manage_system', 'social_posts')
  async publishNow(@Param('id') id: string) {
    return this.socialPostsService.publishNow(id);
  }
}
