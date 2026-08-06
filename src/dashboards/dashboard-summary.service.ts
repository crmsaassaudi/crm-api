import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ClsService } from 'nestjs-cls';

import {
  DealSchemaClass,
  DealSchemaDocument,
} from '../deals/infrastructure/persistence/document/entities/deal.schema';
import {
  TicketSchemaClass,
  TicketSchemaDocument,
} from '../tickets/infrastructure/persistence/document/entities/ticket.schema';
import {
  OmniConversationDocument,
  OmniConversationSchemaClass,
} from '../omni-inbound/infrastructure/persistence/document/entities/omni-conversation.schema';
import {
  applyReportQueryOptions,
  reportAggregate,
} from '../reports/shared/utils/report-aggregate.util';
import { detectCurrencyMix } from '../reports/shared/utils/report-currency.util';
import {
  buildConversationReportVisibilityFilter,
  buildCrmReportVisibilityFilter,
} from '../reports/shared/utils/report-visibility-filter.util';

export interface DashboardStageSlice {
  stageId: string | null;
  stageName: string;
  stageColor: string;
  dealCount: number;
  totalValue: number;
}

export interface DashboardSummary {
  deals: {
    /** Value of deals still in play — won and lost are excluded on purpose. */
    openValue: number;
    openCount: number;
    wonCount: number;
    lostCount: number;
    wonValue: number;
    /** Won / (won + lost), rounded. -1 when nothing has closed yet. */
    winRate: number;
    /**
     * True when `openValue`/`wonValue` add up deals held in more than one
     * currency. The figures are then not comparable and the UI says so.
     */
    currencyMixed: boolean;
  };
  /** Open pipeline broken down by stage, in board order. */
  pipelineByStage: DashboardStageSlice[];
  conversations: { openCount: number };
  tickets: { openCount: number };
}

type StageRow = {
  _id: Types.ObjectId | null;
  dealCount: number;
  totalValue: number;
  stage?: {
    label?: string;
    color?: string;
    isWon?: boolean;
    isLost?: boolean;
  };
};

/**
 * The numbers behind the home dashboard, counted by the database.
 *
 * Every figure here used to be derived in the browser from `GET /deals?limit=100`
 * and `GET /tickets?limit=10`: pipeline value was the sum of the first hundred
 * deals, "open conversations" could not exceed ten because it was the length of a
 * ten-row page, and the win rate compared a populated stage object against the
 * string `'Won'` and so was permanently 0%. A dashboard that is confidently wrong
 * is worse than one that is missing, so the arithmetic moved to where the whole
 * collection is.
 *
 * The same visibility predicate the reports use is applied here. A rep must not
 * read the tenant's pipeline total off the home page when every list they can
 * open is scoped to their own records.
 */
@Injectable()
export class DashboardSummaryService {
  constructor(
    @InjectModel(DealSchemaClass.name)
    private readonly dealModel: Model<DealSchemaDocument>,
    @InjectModel(TicketSchemaClass.name)
    private readonly ticketModel: Model<TicketSchemaDocument>,
    @InjectModel(OmniConversationSchemaClass.name)
    private readonly conversationModel: Model<OmniConversationDocument>,
    private readonly cls: ClsService,
  ) {}

  async getSummary(): Promise<DashboardSummary> {
    const tenantId = this.tenantObjectId();

    const dealMatch = {
      tenantId,
      deletedAt: null,
      ...buildCrmReportVisibilityFilter(this.cls, 'Deal'),
    };

    const [stageRows, currencyMix, openConversations, openTickets] =
      await Promise.all([
        this.aggregateDealsByStage(dealMatch),
        detectCurrencyMix(this.dealModel, dealMatch),
        this.countOpenConversations(tenantId),
        this.countOpenTickets(tenantId),
      ]);

    return {
      ...this.foldStageRows(stageRows, currencyMix.isMixed),
      conversations: { openCount: openConversations },
      tickets: { openCount: openTickets },
    };
  }

  /**
   * One pass over the deals produces both the KPI row and the pipeline chart.
   * Grouping by `stageId` and joining the stage is what makes `isWon`/`isLost`
   * available — the deal itself carries neither, which is why every client-side
   * attempt at a win rate has been wrong.
   */
  private aggregateDealsByStage(
    match: Record<string, unknown>,
  ): Promise<StageRow[]> {
    return reportAggregate<StageRow>(this.dealModel, [
      { $match: match },
      {
        $group: {
          _id: '$stageId',
          dealCount: { $sum: 1 },
          totalValue: { $sum: '$value' },
        },
      },
      {
        $lookup: {
          from: 'deal_stages',
          localField: '_id',
          foreignField: '_id',
          as: 'stage',
        },
      },
      { $unwind: { path: '$stage', preserveNullAndEmptyArrays: true } },
      { $sort: { 'stage.sortOrder': 1, dealCount: -1 } },
    ]).exec();
  }

  private foldStageRows(
    rows: StageRow[],
    currencyMixed: boolean,
  ): Pick<DashboardSummary, 'deals' | 'pipelineByStage'> {
    let openValue = 0;
    let openCount = 0;
    let wonCount = 0;
    let wonValue = 0;
    let lostCount = 0;
    const pipelineByStage: DashboardStageSlice[] = [];

    for (const row of rows) {
      const value = row.totalValue ?? 0;

      if (row.stage?.isWon) {
        wonCount += row.dealCount;
        wonValue += value;
        continue;
      }
      if (row.stage?.isLost) {
        lostCount += row.dealCount;
        continue;
      }

      // A deal whose stage was deleted is still open work someone owns. Dropping
      // it would quietly shrink the pipeline; it gets its own labelled slice.
      openCount += row.dealCount;
      openValue += value;
      pipelineByStage.push({
        stageId: row._id?.toString() ?? null,
        stageName: row.stage?.label ?? 'Unassigned stage',
        stageColor: row.stage?.color ?? '#64748b',
        dealCount: row.dealCount,
        totalValue: value,
      });
    }

    const closed = wonCount + lostCount;

    return {
      deals: {
        openValue,
        openCount,
        wonCount,
        lostCount,
        wonValue,
        // -1, not 0: "no deal has closed yet" and "every closed deal was lost"
        // are different facts and a 0% badge states the second one.
        winRate: closed > 0 ? Math.round((wonCount / closed) * 100) : -1,
        currencyMixed,
      },
      pipelineByStage,
    };
  }

  private countOpenConversations(tenantId: Types.ObjectId): Promise<number> {
    return applyReportQueryOptions(
      this.conversationModel.countDocuments({
        tenantId,
        status: { $in: ['open', 'pending'] },
        ...buildConversationReportVisibilityFilter(this.cls),
      }),
    ).exec();
  }

  /** `closedAt` is the terminal marker; the status catalogue is per-tenant. */
  private countOpenTickets(tenantId: Types.ObjectId): Promise<number> {
    return applyReportQueryOptions(
      this.ticketModel.countDocuments({
        tenantId,
        deletedAt: null,
        closedAt: null,
        ...buildCrmReportVisibilityFilter(this.cls, 'Ticket'),
      }),
    ).exec();
  }

  private tenantObjectId(): Types.ObjectId {
    return new Types.ObjectId(this.cls.get<string>('tenantId'));
  }
}
