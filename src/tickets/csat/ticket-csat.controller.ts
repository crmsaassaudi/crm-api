import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Public } from '../../auth/decorators/public.decorator';
import { TicketCsatService } from './ticket-csat.service';

export class SubmitTicketCsatDto {
  @IsInt()
  @Min(1)
  @Max(5)
  score: number;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  comment?: string;
}

/**
 * The customer-facing survey.
 *
 * Public and unauthenticated — the recipient is a customer with no account.
 * The token is the entire authorisation: 128 bits of randomness, unique-indexed,
 * expiring after a week and spent on first use. Both routes are throttled
 * because a public write endpoint keyed on a bearer-like string is exactly what
 * gets probed.
 */
@ApiTags('Ticket CSAT')
@Controller({ path: 'ticket-csat', version: '1' })
export class TicketCsatController {
  constructor(private readonly service: TicketCsatService) {}

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get(':token')
  @ApiOperation({ summary: 'Describe the survey behind a token (public)' })
  describe(@Param('token') token: string) {
    return this.service.describe(token);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post(':token')
  @ApiOperation({ summary: 'Submit a ticket CSAT rating (public)' })
  submit(@Param('token') token: string, @Body() dto: SubmitTicketCsatDto) {
    return this.service.submit(token, dto);
  }
}
