import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Record consent for ONE identity.
 *
 * `optIn` is deliberately nullable and three-valued: `true` (consented), `false`
 * (explicitly refused), `null` (no answer recorded). Collapsing the last two into a
 * single boolean — which the contact-level `emailOptIn` flag did — is how a system
 * ends up unable to prove it ever had permission, because "never asked" and "said no"
 * become indistinguishable after the fact.
 */
export class SetIdentityConsentDto {
  @ApiPropertyOptional({
    description:
      'true = consented, false = explicitly refused, null = no answer recorded.',
    nullable: true,
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  optIn?: boolean | null;
}

/**
 * Deliverability facts about one identity, both of which are per-identity rather than
 * per-contact: an address can bounce while the contact's other address works.
 */
export class SetIdentityDeliverabilityDto {
  @ApiPropertyOptional({
    description:
      'Confirmed reachable — a reply, a click-through, a successful send. Distinct ' +
      'from merely recorded: an address typed into a form has never been verified.',
  })
  @IsOptional()
  @IsBoolean()
  verified?: boolean;

  @ApiPropertyOptional({
    description:
      'Set after a hard bounce so the next campaign skips this address. Pass false ' +
      'to clear it once the address is known good again.',
  })
  @IsOptional()
  @IsBoolean()
  bounced?: boolean;
}
