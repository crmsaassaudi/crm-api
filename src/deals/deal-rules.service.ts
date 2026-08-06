import { Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { CrmSettingsService } from '../crm-settings/crm-settings.service';
import { DEAL_RULES_SETTING_KEY, DEFAULT_DEAL_RULES } from './deals.constants';

export interface DealRules {
  /** A won deal must carry an amount greater than zero. */
  requireValueOnWin: boolean;
  requireOwnerOnWin: boolean;
  requireContactOnWin: boolean;
  requireCloseDateOnWin: boolean;
  /** Hours after creation a new deal owes its first touch. 0 disables the default. */
  followUpDefaultOffsetHours: number;
  /** Hours a follow-up may be overdue before it is escalated to the owner's manager. */
  followUpEscalationHours: number;
}

/**
 * The tenant's deal rules, read once per request.
 *
 * Every rule here sits on a write path — closing a deal, creating one — so
 * reading the settings document per call would put a round trip in front of each
 * of them. CLS is the right cache: it lives exactly as long as the request that
 * must see one consistent answer, and it cannot leak one tenant's configuration
 * into another tenant's request the way a process-wide map would.
 */
@Injectable()
export class DealRulesService {
  private readonly logger = new Logger(DealRulesService.name);
  private static readonly CLS_KEY = 'dealRules';

  constructor(
    private readonly settings: CrmSettingsService,
    private readonly cls: ClsService,
  ) {}

  async get(): Promise<DealRules> {
    const cached = this.cls.get<DealRules>(DealRulesService.CLS_KEY);
    if (cached) return cached;

    let rules = DEFAULT_DEAL_RULES;
    try {
      const stored = await this.settings.getSetting(DEAL_RULES_SETTING_KEY);
      if (stored) rules = { ...DEFAULT_DEAL_RULES, ...stored };
    } catch (error) {
      // A settings read failure must not block writes: these are data-quality
      // rules, not authorization, so the defaults apply and the failure is loud.
      this.logger.error(
        `Could not load deal rules; using defaults: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    this.cls.set(DealRulesService.CLS_KEY, rules);
    return rules;
  }
}
