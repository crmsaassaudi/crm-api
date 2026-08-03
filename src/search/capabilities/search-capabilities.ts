/**
 * Which engine answers which search question — declared, not inferred.
 *
 * Before this file the engine was chosen by one global boolean plus a circuit
 * breaker, i.e. by *the state of the infrastructure* rather than by *the nature
 * of the question*. That had two consequences worth naming, because they are the
 * reason this registry exists rather than being another layer:
 *
 * 1. A lookup that must be exact (a phone number, a ticket number, an export)
 *    could silently change engine because a cluster came back up.
 * 2. `OPENSEARCH_FALLBACK_TO_MONGODB` was one flag for every capability, so an
 *    OpenSearch outage redirected *every* search — including ones MongoDB can
 *    only answer with a collection scan — at the primary, all at once. A failure
 *    in a secondary system became a failure of the whole product. Fallback is a
 *    decision about blast radius, not about user experience.
 *
 * The rule that keeps the model honest: two engines answering differently is
 * fine; two engines answering differently *without anyone declaring it* is not.
 */

/** Correctness class. See `SearchCapability` for how it constrains routing. */
export type SearchTier =
  /**
   * Exact. There is one right answer, a user can prove the result wrong, and it
   * is used to decide or to write. MongoDB owns these permanently — not as a
   * fallback, as the owner. There is no "degraded" mode because there is
   * nothing to degrade to.
   */
  | 'E'
  /**
   * Relevance. There is no single right answer; a missing row cannot be shown
   * to be wrong. OpenSearch owns these. When it is unavailable the answer is
   * `degrade` or `off` — never a silent substitution.
   */
  | 'R'
  /**
   * Hybrid. OpenSearch narrows the candidate set, MongoDB is the final arbiter
   * for everything that must be exact (ACL, deleted, archived, ordering).
   * Reserved for list views past the thresholds in the audit; nothing uses it
   * yet, and it is listed here so the vocabulary exists before the code does.
   */
  | 'H';

/**
 * What happens when the owning engine cannot serve the request.
 *
 * `degrade` is only legitimate when MongoDB has an **index-backed** path for
 * that capability. When the alternative is a scan, the policy has to be `off`:
 * an unavailable feature is recoverable, a saturated primary is not.
 */
export type UnavailablePolicy = 'degrade' | 'off';

export interface SearchCapability {
  readonly tier: SearchTier;
  readonly owner: 'mongodb' | 'opensearch';
  /** Required when `owner` is opensearch; meaningless otherwise. */
  readonly onOwnerUnavailable?: UnavailablePolicy;
  /**
   * The sentence shown to the user while degraded. If it cannot be written,
   * the degradation has not been thought through and the policy should be
   * `off`.
   */
  readonly degradedSemantics?: string;
  readonly description: string;
}

/**
 * Every search capability the code actually has. Adding a capability means
 * adding a row here first — `search-capabilities.spec.ts` asserts that no
 * capability claims OpenSearch without the policy fields that make the claim
 * safe.
 */
export const SEARCH_CAPABILITIES = {
  global_search: {
    tier: 'R',
    owner: 'opensearch',
    onOwnerUnavailable: 'degrade',
    degradedSemantics:
      'Kết quả đang lấy từ cơ sở dữ liệu chính: khớp hẹp hơn và sắp xếp theo thời gian cập nhật thay vì độ liên quan.',
    description: 'Ô tìm kiếm toàn cục trên thanh điều hướng.',
  },
  contact_list: {
    tier: 'E',
    owner: 'mongodb',
    description:
      'Danh sách contact có filter, sort và đếm — phải chính xác và đọc-sau-ghi.',
  },
  conversation_list: {
    tier: 'E',
    owner: 'mongodb',
    description: 'Hộp thư Omni: filter chính xác, sắp xếp theo lastMessageAt.',
  },
  message_search_in_thread: {
    tier: 'E',
    owner: 'mongodb',
    description:
      'Tìm nội dung tin nhắn trong phạm vi một hội thoại hoặc một khách hàng.',
  },
  export: {
    tier: 'E',
    owner: 'mongodb',
    description:
      'Xuất dữ liệu — thiếu một dòng trong tệp gửi khách là lỗi không sửa được sau đó.',
  },
  duplicate_detection: {
    tier: 'E',
    owner: 'mongodb',
    description:
      'Phát hiện trùng khi merge — kết quả gần đúng ở đây nghĩa là gộp nhầm hai khách hàng.',
  },
  /**
   * Danh sách task có filter/sort/đếm.
   *
   * Tier E và MongoDB sở hữu vĩnh viễn, cùng lý do như `contact_list`: người dùng
   * lọc "task quá hạn của tôi" rồi hành động trên đúng danh sách đó, nên thiếu một
   * dòng là sai chứ không phải "kém liên quan". Có index hậu thuẫn
   * (`task_list_default`, `task_owner_due`, `task_status_due`,
   * `task_related_lookup`) nên không có đường suy giảm nào cần khai báo.
   */
  task_list: {
    tier: 'E',
    owner: 'mongodb',
    description:
      'Danh sách task có filter, sort và đếm — phải chính xác và đọc-sau-ghi.',
  },
  /**
   * Ô tìm kiếm tự do trong danh sách task.
   *
   * Tách khỏi `task_list` vì đây là câu hỏi khác hạng: gõ "renewal" là đi tìm mức
   * độ liên quan, không phải một câu trả lời đúng duy nhất. Hiện MongoDB trả lời
   * bằng `$regex` không neo, case-insensitive trên `title` + `description` —
   * **không index nào phục vụ được**, tức là collection scan.
   *
   * Khai báo `owner: 'mongodb'` là nói thật về hiện trạng, không phải chấp nhận
   * nó: đây là chỗ duy nhất trong registry mà chủ sở hữu tier R là MongoDB, và
   * `description` ghi rõ chi phí để lần chuyển sang OpenSearch có một mục tiêu cụ
   * thể. Không đặt `owner: 'opensearch'` vì Task chưa hề được index — khai báo như
   * vậy sẽ là một lời hứa mà `src/search/indexing/` không giữ được.
   */
  task_list_search: {
    tier: 'R',
    owner: 'mongodb',
    description:
      'Tìm tự do trong danh sách task. Hiện dùng $regex → collection scan; ' +
      'ứng viên chuyển sang OpenSearch khi tenant vượt ~100k task.',
  },
} as const satisfies Record<string, SearchCapability>;

export type SearchCapabilityName = keyof typeof SEARCH_CAPABILITIES;

export const SEARCH_CAPABILITY_NAMES = Object.keys(
  SEARCH_CAPABILITIES,
) as SearchCapabilityName[];

/** An operator override. Only ever narrows — see {@link resolveCapability}. */
export type CapabilityOverride = 'mongodb' | 'off';

export interface CapabilityPlan {
  capability: SearchCapabilityName;
  /** The engine that should be tried first. Undefined when disabled. */
  engine?: 'mongodb' | 'opensearch';
  /** The capability is switched off; the API must say so, not answer anyway. */
  disabled: boolean;
  /**
   * True when configuration — not a failure — routes this away from its owner.
   *
   * Deliberately **not** the same thing as `degraded`. Degradation is the gap
   * between what the configuration promised and what actually happened, not the
   * gap between reality and some ideal. On a deployment that has never enabled
   * OpenSearch, MongoDB answering is the product working as configured; marking
   * every such response degraded would put a permanent warning in the UI and
   * teach everyone to ignore the one that matters.
   */
  divertedByConfig: boolean;
  /** Machine-readable cause, used as a metric label and in the response. */
  reason?: string;
  /** The sentence to show if this capability degrades at runtime. */
  degradedSemantics?: string;
  policy: UnavailablePolicy;
}

export interface CapabilityRuntime {
  /** `OPENSEARCH_ENABLED`. The kill switch: it wins over everything below. */
  openSearchEnabled: boolean;
  /** Per-capability operator overrides, already parsed and validated. */
  overrides: Partial<Record<SearchCapabilityName, CapabilityOverride>>;
}

/**
 * `as const satisfies` narrows every entry to its own literal type, which is
 * what makes the registry self-documenting — and which also means indexing it
 * yields a union whose members do not all share the optional fields. Reading a
 * definition through here restores the common shape, so callers can ask about
 * `onOwnerUnavailable` without knowing which row they got.
 */
export const capabilityDefinition = (
  name: SearchCapabilityName,
): SearchCapability => SEARCH_CAPABILITIES[name];

const definitionOf = capabilityDefinition;

export const capabilityPolicy = (
  name: SearchCapabilityName,
): UnavailablePolicy => definitionOf(name).onOwnerUnavailable ?? 'off';

/**
 * Resolves the three configuration levels into one plan.
 *
 * The levels are ordered kill switch → per-capability override → (per-tenant,
 * layered on top by the caller), and each level may only **narrow** what the
 * level above allows. Widening would mean a row in the database could defeat
 * the kill switch, at exactly the moment somebody is reaching for it.
 */
export function resolveCapability(
  name: SearchCapabilityName,
  runtime: CapabilityRuntime,
): CapabilityPlan {
  const definition = definitionOf(name);
  const policy = capabilityPolicy(name);
  const override = runtime.overrides[name];

  if (override === 'off') {
    return {
      capability: name,
      disabled: true,
      divertedByConfig: true,
      policy,
      reason: 'disabled_by_config',
    };
  }

  if (definition.owner === 'mongodb') {
    // A tier-E capability is never routed to OpenSearch, so neither the kill
    // switch nor an override can change what serves it. `mongodb` as an
    // override is accepted and is a no-op; it is how an operator writes down
    // "yes, deliberately".
    return {
      capability: name,
      engine: 'mongodb',
      disabled: false,
      divertedByConfig: false,
      policy,
    };
  }

  const forcedToMongo = override === 'mongodb';
  const unavailable = !runtime.openSearchEnabled || forcedToMongo;
  if (!unavailable) {
    return {
      capability: name,
      engine: 'opensearch',
      disabled: false,
      divertedByConfig: false,
      // Carried even when nothing has gone wrong: the router needs the sentence
      // ready for the moment the engine fails mid-request, which is after this
      // plan was resolved.
      ...(definition.degradedSemantics
        ? { degradedSemantics: definition.degradedSemantics }
        : {}),
      policy,
    };
  }

  const reason = forcedToMongo ? 'forced_to_mongodb' : 'opensearch_disabled';
  if (policy === 'off') {
    return {
      capability: name,
      disabled: true,
      divertedByConfig: true,
      policy,
      reason,
    };
  }
  return {
    capability: name,
    engine: 'mongodb',
    disabled: false,
    divertedByConfig: true,
    reason,
    ...(definition.degradedSemantics
      ? { degradedSemantics: definition.degradedSemantics }
      : {}),
    policy,
  };
}

export class CapabilityOverrideError extends Error {}

/**
 * Parses `SEARCH_CAPABILITY_OVERRIDES=global_search:mongodb,export:off`.
 *
 * Rejects at boot rather than at request time: a typo that silently does
 * nothing is worse than a container that refuses to start, because the first
 * one is discovered during an incident.
 */
export function parseCapabilityOverrides(
  raw: string | undefined,
): Partial<Record<SearchCapabilityName, CapabilityOverride>> {
  if (!raw?.trim()) return {};
  const overrides: Partial<Record<SearchCapabilityName, CapabilityOverride>> =
    {};
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const [name, value] = trimmed.split(':').map((part) => part?.trim());
    if (!name || !value) {
      throw new CapabilityOverrideError(
        `SEARCH_CAPABILITY_OVERRIDES entry "${trimmed}" must be "<capability>:<mongodb|off>"`,
      );
    }
    if (!(name in SEARCH_CAPABILITIES)) {
      throw new CapabilityOverrideError(
        `SEARCH_CAPABILITY_OVERRIDES refers to unknown capability "${name}". Known: ${SEARCH_CAPABILITY_NAMES.join(', ')}`,
      );
    }
    const capability = name as SearchCapabilityName;
    if (value === 'opensearch') {
      // The only direction an override may move is towards less. Allowing this
      // would let configuration hand a tier-E question to an engine that cannot
      // answer it exactly — and would let a per-tenant row re-enable something
      // the kill switch turned off.
      throw new CapabilityOverrideError(
        `SEARCH_CAPABILITY_OVERRIDES cannot route "${capability}" to OpenSearch: an override may only narrow (mongodb|off).`,
      );
    }
    if (value !== 'mongodb' && value !== 'off') {
      throw new CapabilityOverrideError(
        `SEARCH_CAPABILITY_OVERRIDES value for "${capability}" must be "mongodb" or "off", received "${value}"`,
      );
    }
    if (value === 'mongodb' && capabilityPolicy(capability) === 'off') {
      // Forcing a capability onto MongoDB is only meaningful when MongoDB has
      // an index-backed path for it. Where the policy is `off`, MongoDB's only
      // option is a scan, and this override would be a slow way of asking for
      // the outage it was meant to avoid.
      throw new CapabilityOverrideError(
        `"${capability}" has no index-backed MongoDB path (policy=off); use "off" instead of "mongodb".`,
      );
    }
    overrides[capability] = value;
  }
  return overrides;
}
