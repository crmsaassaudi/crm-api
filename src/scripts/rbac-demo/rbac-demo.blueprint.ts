/**
 * RBAC / ABAC FIXTURE BLUEPRINT — the single declarative description of the
 * authorization fixture, shared by the seeder and the verifier.
 *
 * Why one file for both: an expectation that lives apart from the data it
 * describes drifts silently. Here, "Nguyễn Thị Mai must see exactly one contact"
 * sits next to the group membership and the role scope that make it true, so a
 * change to either side is visible in the same diff.
 *
 * WHAT LANDS IN THE DATABASE READS AS REAL BUSINESS DATA. Roles, org units,
 * groups, policies and contacts are named the way a customer would name them —
 * no "Demo", no "Test", no fixture keys leaking into display text. The reason is
 * practical: this fixture is seeded into the tenant people open the app with, and
 * a role list where half the rows are prefixed with a marker is not a screen
 * anyone can judge the product from. Everything the ENGINEERING intent needs to
 * say lives in comments here, which never reach the database.
 *
 * Fixture rows are still recoverable, without borrowing display text for it:
 * every document the seeder writes carries a `seedTag` field, and `--purge`
 * matches on exactly that.
 *
 * Every axis of the authorization model is exercised by at least one account:
 *
 *   RBAC   · direct roleIds            → EMAIL.repNorth2, EMAIL.mgrNorth, …
 *          · group-inherited roleIds   → EMAIL.repNorth1, EMAIL.agentSupport
 *          · per-user override allow    → EMAIL.repNorth2 (contacts:delete)
 *          · per-user override deny     → EMAIL.repSouth  (deals:create)
 *          · tenant ADMIN flag          → EMAIL.admin (whole ceiling, no role rows)
 *          · JIT (time-boxed) grant     → EMAIL.jit (active) / EMAIL.noGrant (expired)
 *          · no grant at all            → EMAIL.noGrant (must be 403 everywhere)
 *
 *   Data scope (row visibility, DataScope enum)
 *          · SELF                       → reps, support agent
 *          · ORG_UNIT                   → EMAIL.mgrNorth, EMAIL.mgrSupport
 *          · ORG_UNIT_SUBTREE           → EMAIL.director
 *          · TENANT                     → EMAIL.analyst
 *          · ADMIN bypass               → EMAIL.admin
 *
 *   ABAC   · resource-attribute deny    → "vip" contact cannot be edited by anyone
 *          · subject-attribute deny     → members of the North sales team cannot delete
 *          · allow (widening) shape     → own-record allow policy
 *
 *   Object ACL
 *          · user-scoped deny           → EMAIL.mgrNorth on their own contact
 *          · group-scoped deny          → North sales team on c-north-1
 *
 * IMPORTANT: the tenant's `data_visibility.defaultScope` is set to `self` by the
 * seeder. Without that, the tenant default is SUBORDINATES and every role scope
 * would be at least that wide, which hides the difference between SELF and the
 * wider scopes — the exact thing this fixture exists to demonstrate.
 */

import { DataScope } from '../../common/permissions/data-scope.enum';

/** Tenant this fixture is seeded into (alias, resolved to an ObjectId at run time). */
export const DEMO_TENANT_ALIAS = process.env.RBAC_DEMO_ALIAS ?? 'master';

/** Shared password for every fixture account. Local/dev only. */
export const DEMO_PASSWORD = process.env.RBAC_DEMO_PASSWORD ?? 'Rbac@Demo2026';

/**
 * Stamped into a `seedTag` field on every document the seeder writes, and the
 * only thing `--purge` matches on.
 *
 * A field rather than a name prefix or a contact tag: both of those are rendered
 * in the UI, and the fixture is worthless as a product surface if its rows
 * announce themselves as fixtures. `seedTag` is invisible to the app — the
 * Mongoose schemas do not declare it, so it never reaches a response — while
 * still marking the rows precisely for cleanup.
 */
export const SEED_TAG = 'rbac-demo';

/** Email domain for the seeded staff accounts. */
export const STAFF_EMAIL_DOMAIN =
  process.env.RBAC_DEMO_EMAIL_DOMAIN ?? 'crmsaudi.dev';

const staff = (local: string) => `${local}@${STAFF_EMAIL_DOMAIN}`;

/**
 * Fixture accounts, addressed by a readable key.
 *
 * The addresses themselves are ordinary employee addresses, so the user list
 * looks like a company's; the keys below are how expectations and probes refer to
 * them, and carry the meaning that `sales.rep.north1@…` used to carry in data
 * a customer would see.
 */
export const EMAIL = {
  admin: staff('anh.nguyen'),
  director: staff('duc.pham'),
  mgrNorth: staff('bac.tran'),
  repNorth1: staff('mai.nguyen'),
  repNorth2: staff('nam.hoang'),
  repSouth: staff('tri.dang'),
  mgrSupport: staff('lan.bui'),
  agentSupport: staff('hai.phan'),
  analyst: staff('tung.do'),
  jit: staff('tam.ly'),
  noGrant: staff('hanh.chu'),
} as const;

/**
 * Identifiers an earlier revision of this fixture used, when its display text was
 * prefixed with "Demo RBAC · " and its accounts lived on `rbacdemo.local`.
 *
 * The seeder clears these on every run. Without it, renaming the fixture would
 * strand the old rows: lookup is keyed on the new names, so nothing adopts them,
 * and the marker `--purge` matches on no longer describes them either.
 */
export const LEGACY = {
  namePrefix: 'Demo RBAC',
  contactTag: 'rbac-demo',
  emailDomain: 'rbacdemo.local',
  jitReasonPrefix: 'RBAC demo',
  orgUnitCodes: [
    'DEMO-HQ',
    'DEMO-SALES',
    'DEMO-SALES-N',
    'DEMO-SALES-S',
    'DEMO-SUPPORT',
  ],
} as const;

export interface OrgUnitSpec {
  code: string;
  name: string;
  description: string;
  parentCode: string | null;
  /** Head of the unit; resolved after users are created. */
  managerEmail?: string;
}

export const ORG_UNITS: OrgUnitSpec[] = [
  {
    code: 'HQ',
    name: 'Trụ sở chính',
    description: 'Ban điều hành và các khối văn phòng.',
    parentCode: null,
  },
  {
    code: 'SALES',
    name: 'Khối Kinh doanh',
    description: 'Toàn bộ hoạt động bán hàng trên cả nước.',
    parentCode: 'HQ',
    managerEmail: EMAIL.director,
  },
  {
    code: 'SALES-N',
    name: 'Kinh doanh Miền Bắc',
    description: 'Phụ trách khách hàng khu vực miền Bắc.',
    parentCode: 'SALES',
    managerEmail: EMAIL.mgrNorth,
  },
  {
    code: 'SALES-S',
    name: 'Kinh doanh Miền Nam',
    description: 'Phụ trách khách hàng khu vực miền Nam.',
    parentCode: 'SALES',
  },
  {
    code: 'CS',
    name: 'Chăm sóc khách hàng',
    description: 'Tiếp nhận và xử lý yêu cầu của khách hàng sau bán.',
    parentCode: 'HQ',
    managerEmail: EMAIL.mgrSupport,
  },
];

// Custom roles

export interface RoleSpec {
  /** Internal handle. Never stored — `custom_roles` has no key column. */
  key: string;
  name: string;
  description: string;
  color: string;
  dataScope: DataScope;
  permissions: string[];
}

const SALES_REP_PERMISSIONS = [
  // Every built-in role template (sys.sales_rep, sys.support_agent, …)
  // grants this — it's what the home dashboard's own KPI summary requires
  // (GET /dashboards/summary). Missing here, a rep's dashboard 403'd on
  // every load and every KPI tile stayed on its loading skeleton forever.
  'dashboards:view',
  'leads:view',
  'leads:create',
  'leads:edit',
  'contacts:view',
  'contacts:create',
  'contacts:edit',
  'accounts:view',
  'accounts:create',
  'accounts:edit',
  'deals:view',
  'deals:create',
  'deals:edit',
  'deals:move_stage',
  'tasks:view',
  'tasks:create',
  'tasks:edit',
  'reports:view',
  'reports:deal:view',
  'tags:view',
  'files:view',
  'files:create',
];

const SALES_MANAGER_PERMISSIONS = [
  ...SALES_REP_PERMISSIONS,
  'leads:delete',
  'leads:assign',
  'leads:import',
  'leads:export',
  'contacts:delete',
  'contacts:import',
  'contacts:export',
  'accounts:delete',
  'accounts:import',
  'accounts:export',
  'deals:delete',
  'deals:import',
  'deals:export',
  'tasks:delete',
  'tasks:export',
  'reports:contact:view',
  'groups:view',
];

const SUPPORT_AGENT_PERMISSIONS = [
  'dashboards:view',
  'tickets:view',
  'tickets:create',
  'tickets:edit',
  'tickets:resolve',
  'contacts:view',
  'accounts:view',
  'tasks:view',
  'tasks:create',
  'tasks:edit',
  'reports:view',
  'reports:ticket:view',
  'tags:view',
  'files:view',
  'omni_channel:view',
  'omni_channel:edit',
  'omni_channel:assign',
  'omni_reports:view',
];

/**
 * Descriptions here are the role's job, in the words a customer would use. The
 * data scope each one carries is deliberately NOT spelled out in the name: the
 * Roles screen already renders the scope as its own line ("Chỉ bản ghi của
 * mình", "Đơn vị của mình", …), so a "(Cá nhân)" suffix would duplicate it and
 * read as fixture bookkeeping.
 */
export const ROLES: RoleSpec[] = [
  {
    // SELF — the narrowest scope; the baseline every wider scope is compared to.
    key: 'sales_rep_self',
    name: 'Nhân viên Kinh doanh',
    description:
      'Chăm sóc khách hàng và cơ hội do mình phụ trách: tạo, cập nhật và đẩy giai đoạn giao dịch.',
    color: '#22c55e',
    dataScope: DataScope.SELF,
    permissions: SALES_REP_PERMISSIONS,
  },
  {
    // ORG_UNIT — sees the unit, not the subtree.
    key: 'sales_mgr_unit',
    name: 'Trưởng phòng Kinh doanh',
    description:
      'Điều hành phòng kinh doanh: phân công, theo dõi và xử lý dữ liệu của cả phòng.',
    color: '#8b5cf6',
    dataScope: DataScope.ORG_UNIT,
    permissions: SALES_MANAGER_PERMISSIONS,
  },
  {
    // ORG_UNIT_SUBTREE — the unit plus every unit beneath it.
    key: 'sales_director_subtree',
    name: 'Giám đốc Kinh doanh',
    description:
      'Quản lý toàn khối kinh doanh, bao gồm dữ liệu và nhân sự của các phòng trực thuộc.',
    color: '#6366f1',
    dataScope: DataScope.ORG_UNIT_SUBTREE,
    permissions: [
      ...SALES_MANAGER_PERMISSIONS,
      'users:view',
      'org_units:view',
      'reports:agent:view',
      'audit_logs:view',
    ],
  },
  {
    key: 'support_agent_self',
    name: 'Nhân viên CSKH',
    description: 'Tiếp nhận và xử lý ticket, hội thoại được phân công.',
    color: '#06b6d4',
    dataScope: DataScope.SELF,
    permissions: SUPPORT_AGENT_PERMISSIONS,
  },
  {
    key: 'support_mgr_unit',
    name: 'Trưởng phòng CSKH',
    description:
      'Quản lý hàng đợi, SLA và nhân sự của phòng chăm sóc khách hàng.',
    color: '#0ea5e9',
    dataScope: DataScope.ORG_UNIT,
    permissions: [
      ...SUPPORT_AGENT_PERMISSIONS,
      'tickets:delete',
      'tickets:import',
      'tickets:export',
      'sla_policies:view',
      'groups:view',
      'users:view',
    ],
  },
  {
    // TENANT — the widest scope in the fixture, and read-only, so scope width and
    // permission breadth are visibly independent.
    key: 'revenue_analyst_tenant',
    name: 'Chuyên viên Phân tích Doanh thu',
    description:
      'Đọc dữ liệu và báo cáo của toàn công ty để phân tích doanh thu. Không chỉnh sửa dữ liệu.',
    color: '#64748b',
    dataScope: DataScope.TENANT,
    permissions: [
      'contacts:view',
      'accounts:view',
      'deals:view',
      'tickets:view',
      'reports:view',
      'reports:contact:view',
      'reports:deal:view',
      'reports:ticket:view',
      'tags:view',
    ],
  },
];

export interface GroupSpec {
  key: string;
  name: string;
  description: string;
  roleKeys: string[];
  memberEmails: string[];
}

/**
 * Each group grants its role by membership. The members below hold no direct
 * `roleIds` at all, which is what makes group inheritance measurable.
 */
export const GROUPS: GroupSpec[] = [
  {
    key: 'sales_north_team',
    name: 'Đội Kinh doanh Miền Bắc',
    description: 'Nhân sự kinh doanh phụ trách các tỉnh phía Bắc.',
    roleKeys: ['sales_rep_self'],
    memberEmails: [EMAIL.repNorth1, EMAIL.repNorth2],
  },
  {
    key: 'support_tier1',
    name: 'CSKH Tầng 1',
    description: 'Tiếp nhận yêu cầu ở tầng đầu tiên trước khi chuyển tiếp.',
    roleKeys: ['support_agent_self'],
    // The manager is a member too: their CONVERSATION_EXPECTATIONS entry says
    // they reach the web pool "through the same group", and without membership
    // they were outside the pool and saw nothing — the fixture contradicted its
    // own note.
    memberEmails: [EMAIL.agentSupport, EMAIL.mgrSupport],
  },
  {
    key: 'revenue_analysts',
    name: 'Nhóm Phân tích Doanh thu',
    description: 'Bộ phận phân tích số liệu doanh thu toàn công ty.',
    roleKeys: ['revenue_analyst_tenant'],
    memberEmails: [EMAIL.analyst],
  },
];

export interface UserSpec {
  email: string;
  fullName: string;
  /** Tenant-level role flags. Only ADMIN/OWNER short-circuit to the ceiling. */
  tenantRoles: string[];
  /** Roles referenced directly on the membership. */
  roleKeys: string[];
  orgUnitCode: string | null;
  reportsToEmail: string | null;
  /** Per-key final say. `true` re-grants, `false` withdraws. */
  permissionOverrides?: Record<string, boolean>;
  /** Time-boxed grant, in hours. Negative = already lapsed (must not count). */
  jitGrant?: { roleKey: string; hours: number; reason: string };
  /** One-line summary of what this account is for. Console output only. */
  purpose: string;
}

export const USERS: UserSpec[] = [
  {
    email: EMAIL.admin,
    fullName: 'Nguyễn Quốc Anh',
    tenantRoles: ['ADMIN'],
    roleKeys: [],
    orgUnitCode: 'HQ',
    reportsToEmail: null,
    purpose:
      'Tenant ADMIN flag: holds the entire tenant ceiling with no role rows, and bypasses the row filter.',
  },
  {
    email: EMAIL.director,
    fullName: 'Phạm Minh Đức',
    tenantRoles: [],
    roleKeys: ['sales_director_subtree'],
    orgUnitCode: 'SALES',
    reportsToEmail: EMAIL.admin,
    purpose: 'ORG_UNIT_SUBTREE scope: sees Sales and both branches beneath it.',
  },
  {
    email: EMAIL.mgrNorth,
    fullName: 'Trần Văn Bắc',
    tenantRoles: [],
    roleKeys: ['sales_mgr_unit'],
    orgUnitCode: 'SALES-N',
    reportsToEmail: EMAIL.director,
    purpose:
      'ORG_UNIT scope: sees Sales North only. Also the target of a user-scoped object-ACL deny.',
  },
  {
    email: EMAIL.repNorth1,
    fullName: 'Nguyễn Thị Mai',
    tenantRoles: [],
    roleKeys: [],
    orgUnitCode: 'SALES-N',
    reportsToEmail: EMAIL.mgrNorth,
    purpose:
      'Group-inherited role only (no direct roleIds). Also hit by the group-scoped object-ACL deny.',
  },
  {
    email: EMAIL.repNorth2,
    fullName: 'Hoàng Văn Nam',
    tenantRoles: [],
    roleKeys: ['sales_rep_self'],
    orgUnitCode: 'SALES-N',
    reportsToEmail: EMAIL.mgrNorth,
    permissionOverrides: { 'contacts:delete': true },
    purpose:
      'Override ALLOW: gains contacts:delete that the role does not grant. Owns the "vip" ABAC contact.',
  },
  {
    email: EMAIL.repSouth,
    fullName: 'Đặng Minh Trí',
    tenantRoles: [],
    roleKeys: ['sales_rep_self'],
    orgUnitCode: 'SALES-S',
    reportsToEmail: EMAIL.director,
    permissionOverrides: { 'deals:create': false },
    purpose:
      'Override DENY: loses deals:create the role grants. Proves cross-branch isolation from Sales North.',
  },
  {
    email: EMAIL.mgrSupport,
    fullName: 'Bùi Thị Lan',
    tenantRoles: [],
    roleKeys: ['support_mgr_unit'],
    orgUnitCode: 'CS',
    reportsToEmail: EMAIL.admin,
    purpose:
      'ORG_UNIT scope in a different branch: no visibility into any sales record.',
  },
  {
    email: EMAIL.agentSupport,
    fullName: 'Phan Văn Hải',
    tenantRoles: [],
    roleKeys: [],
    orgUnitCode: 'CS',
    reportsToEmail: EMAIL.mgrSupport,
    purpose:
      'Group-inherited support role, SELF scope. Has no sales permissions at all.',
  },
  {
    email: EMAIL.analyst,
    fullName: 'Đỗ Thanh Tùng',
    tenantRoles: [],
    roleKeys: [],
    orgUnitCode: 'HQ',
    reportsToEmail: EMAIL.admin,
    purpose:
      'TENANT scope with read-only permissions: sees every row, can mutate nothing.',
  },
  {
    email: EMAIL.jit,
    fullName: 'Lý Thanh Tâm',
    tenantRoles: [],
    roleKeys: [],
    orgUnitCode: 'CS',
    reportsToEmail: EMAIL.mgrSupport,
    jitGrant: {
      roleKey: 'support_agent_self',
      hours: 8,
      reason: 'Trực ca thay nhân viên CSKH nghỉ phép trong ngày',
    },
    purpose:
      'ACTIVE JIT grant: holds the support role for 8 hours through role_assignments, not roleIds.',
  },
  {
    email: EMAIL.noGrant,
    fullName: 'Chu Thị Hạnh',
    tenantRoles: [],
    roleKeys: [],
    orgUnitCode: null,
    reportsToEmail: null,
    jitGrant: {
      roleKey: 'sales_rep_self',
      hours: -24,
      reason: 'Hỗ trợ chiến dịch bán hàng đợt trước (đã hết hiệu lực)',
    },
    purpose:
      'Fail-closed baseline: a member with an EXPIRED grant and nothing else must be 403 everywhere.',
  },
];

// Contact fixtures (the rows data scope is measured on)

export interface ContactSpec {
  /**
   * Internal handle, used by expectations and probes. Never written to the row —
   * the seeder and the verifier find a contact by its `email`, so both the
   * display name and the key can change without breaking lookup.
   */
  key: string;
  firstName: string;
  lastName: string;
  title: string;
  companyName: string;
  email: string;
  ownerEmail: string | null;
  orgUnitCode: string | null;
  tags: string[];
}

/**
 * Nine customer contacts: one per account, plus one deliberately unowned. They
 * are ordinary CRM rows — no marker in the name, no marker in the tags. The only
 * tag with meaning to the fixture is `vip`, which is exactly the kind of tag a
 * real tenant would have, and which the ABAC deny policy matches on.
 */
export const CONTACTS: ContactSpec[] = [
  {
    key: 'c-admin',
    firstName: 'Ngọc',
    lastName: 'Nguyễn Thị Bích',
    title: 'Giám đốc điều hành',
    companyName: 'Thái Bình Group',
    email: 'ngoc.nguyen@thaibinhgroup.vn',
    ownerEmail: EMAIL.admin,
    orgUnitCode: 'HQ',
    tags: ['khách hàng doanh nghiệp'],
  },
  {
    key: 'c-director',
    firstName: 'Khánh',
    lastName: 'Lê Duy',
    title: 'Trưởng phòng Mua hàng',
    companyName: 'An Phát Co.',
    email: 'khanh.le@anphatco.vn',
    ownerEmail: EMAIL.director,
    orgUnitCode: 'SALES',
    tags: ['khách hàng doanh nghiệp'],
  },
  {
    key: 'c-north-mgr',
    firstName: 'Linh',
    lastName: 'Phạm Thùy',
    title: 'Giám đốc Tài chính',
    companyName: 'Hà Nội Tech',
    email: 'linh.pham@hanoitech.vn',
    ownerEmail: EMAIL.mgrNorth,
    orgUnitCode: 'SALES-N',
    tags: ['đang đàm phán'],
  },
  {
    key: 'c-north-1',
    firstName: 'Sơn',
    lastName: 'Đinh Tùng',
    title: 'Quản lý Dự án',
    companyName: 'Vinacom',
    email: 'son.dinh@vinacom.vn',
    ownerEmail: EMAIL.repNorth1,
    orgUnitCode: 'SALES-N',
    tags: ['tiềm năng'],
  },
  {
    key: 'c-north-2',
    firstName: 'Trâm',
    lastName: 'Bùi Ngọc',
    title: 'Chủ tịch HĐQT',
    companyName: 'Minh Long Group',
    email: 'tram.bui@minhlonggroup.vn',
    ownerEmail: EMAIL.repNorth2,
    orgUnitCode: 'SALES-N',
    // `vip` is what the resource-attribute deny policy matches on.
    tags: ['vip', 'khách hàng doanh nghiệp'],
  },
  {
    key: 'c-south',
    firstName: 'Phúc',
    lastName: 'Huỳnh Gia',
    title: 'Trưởng phòng Kỹ thuật',
    companyName: 'Sài Gòn Solutions',
    email: 'phuc.huynh@saigonsolutions.vn',
    ownerEmail: EMAIL.repSouth,
    orgUnitCode: 'SALES-S',
    tags: ['tiềm năng'],
  },
  {
    key: 'c-support-mgr',
    firstName: 'Hạnh',
    lastName: 'Trương Mỹ',
    title: 'Quản lý Vận hành',
    companyName: 'Đồng Tâm Logistics',
    email: 'hanh.truong@dongtamlogistics.vn',
    ownerEmail: EMAIL.mgrSupport,
    orgUnitCode: 'CS',
    tags: ['đang hỗ trợ'],
  },
  {
    key: 'c-support-1',
    firstName: 'Dũng',
    lastName: 'Cao Tiến',
    title: 'Chuyên viên Hỗ trợ',
    companyName: 'Việt Link JSC',
    email: 'dung.cao@vietlinkjsc.vn',
    ownerEmail: EMAIL.agentSupport,
    orgUnitCode: 'CS',
    tags: ['đang hỗ trợ'],
  },
  {
    key: 'c-unowned',
    firstName: 'Vy',
    lastName: 'Tạ Hải',
    title: 'Trưởng phòng Marketing',
    companyName: 'New Wave Media',
    email: 'vy.ta@newwavemedia.vn',
    // Unowned on purpose: unowned rows must not leak to scoped users.
    ownerEmail: null,
    orgUnitCode: null,
    tags: ['chưa phân công'],
  },
];

// Omni channels

export interface ChannelSpec {
  key: string;
  type: string;
  name: string;
  /** Provider account id. Namespaced so it cannot collide with a real page. */
  account: string;
  /**
   * 'restricted' makes the support pool an authorization boundary — only the
   * listed users and groups may be assigned to, or read, this channel's
   * conversations. 'open' leaves it a routing preference.
   */
  mode: 'restricted' | 'open';
  supportUserEmails: string[];
  supportGroupKeys: string[];
  /** What this channel proves. Console output and reviewer orientation only. */
  purpose: string;
}

/**
 * Three channels spanning the interesting combinations: restricted-by-group,
 * restricted-by-user, and open. Without an open channel in the set, a bug that
 * restricted everything would still pass every probe.
 */
export const CHANNELS: ChannelSpec[] = [
  {
    key: 'ch_web_support',
    type: 'livechat',
    name: 'Website Support',
    account: 'rbacdemo-web-support',
    mode: 'restricted',
    supportUserEmails: [],
    supportGroupKeys: ['support_tier1'],
    purpose:
      'Restricted to one group. Support agents serve it; sales must not see it.',
  },
  {
    key: 'ch_sales_page',
    type: 'facebook',
    name: 'Fanpage Kinh doanh',
    account: 'rbacdemo-sales-page',
    mode: 'restricted',
    supportUserEmails: [EMAIL.repNorth1, EMAIL.mgrNorth],
    supportGroupKeys: [],
    purpose:
      'Restricted to named users, no group. Proves the user axis works on its own.',
  },
  {
    key: 'ch_shared_email',
    type: 'email',
    name: 'Hộp thư chung',
    account: 'support@rbacdemo.example',
    mode: 'open',
    supportUserEmails: [],
    supportGroupKeys: [],
    purpose:
      'Open channel: everyone with omni_channel:view may read it. The control case.',
  },
];

export interface RoutingRuleSpec {
  key: string;
  name: string;
  priority: number;
  matchType: 'all' | 'any';
  conditions: Array<{ field: string; operator: string; value: string }>;
  /** Seeder resolves exactly one of these into the rule's actions. */
  targetGroupKey?: string;
  targetUserEmail?: string;
  strategy: string;
  purpose: string;
}

/**
 * Rules are evaluated by ascending priority, first match wins. The
 * `{{channelId:<key>}}` placeholder is resolved by the seeder once the channels
 * have ids.
 */
export const ROUTING_RULES: RoutingRuleSpec[] = [
  {
    key: 'rr_vip_to_manager',
    name: 'Khách VIP về Trưởng phòng CSKH',
    priority: 0,
    matchType: 'all',
    conditions: [{ field: 'tag', operator: 'eq', value: 'vip' }],
    targetUserEmail: EMAIL.mgrSupport,
    strategy: 'manual',
    purpose:
      'Pins a single agent. Proves actions.userId short-circuits strategy selection.',
  },
  {
    key: 'rr_web_to_tier1',
    name: 'Livechat website về CSKH Tầng 1',
    priority: 1,
    matchType: 'all',
    conditions: [
      {
        field: 'channel_id',
        operator: 'eq',
        value: '{{channelId:ch_web_support}}',
      },
    ],
    targetGroupKey: 'support_tier1',
    strategy: 'round_robin',
    purpose:
      'Matches one specific channel, not a channel type — the case channelType alone cannot express.',
  },
  {
    key: 'rr_sales_page_to_north',
    name: 'Fanpage kinh doanh về Đội Miền Bắc',
    priority: 2,
    matchType: 'all',
    conditions: [{ field: 'channel', operator: 'eq', value: 'facebook' }],
    targetGroupKey: 'sales_north_team',
    strategy: 'round_robin',
    purpose:
      'Group routing whose members also sit in the channel pool — the happy path.',
  },
];

// Omni conversations

export interface ConversationSpec {
  key: string;
  channelKey: string;
  /** Provider-side thread id. Unique per channel. */
  externalId: string;
  customerName: string;
  status: 'open' | 'pending' | 'resolved';
  assignedAgentEmail: string | null;
  assignedGroupKey: string | null;
  tags: string[];
  purpose: string;
}

/**
 * Conversations chosen to exercise every branch of the visibility scope:
 * assigned-to-me, assigned-to-a-colleague, group-queued with no agent, wholly
 * unassigned, and cross-channel.
 */
export const CONVERSATIONS: ConversationSpec[] = [
  {
    key: 'cv_web_assigned_agent',
    channelKey: 'ch_web_support',
    externalId: 'rbacdemo-web-001',
    customerName: 'Trần Thu Hà',
    status: 'open',
    assignedAgentEmail: EMAIL.agentSupport,
    assignedGroupKey: 'support_tier1',
    tags: [],
    purpose: 'Assigned to the support agent — their own row.',
  },
  {
    key: 'cv_web_group_queue',
    channelKey: 'ch_web_support',
    externalId: 'rbacdemo-web-002',
    customerName: 'Lê Văn Sơn',
    status: 'pending',
    // No agent, but owned by the group: the case that was invisible before
    // auto-routing started persisting assignedGroupId.
    assignedAgentEmail: null,
    assignedGroupKey: 'support_tier1',
    tags: [],
    purpose:
      'Group queue with no agent. Visible to group members, not to outsiders.',
  },
  {
    key: 'cv_web_unassigned',
    channelKey: 'ch_web_support',
    externalId: 'rbacdemo-web-003',
    customerName: 'Đỗ Minh Khoa',
    status: 'open',
    assignedAgentEmail: null,
    assignedGroupKey: null,
    tags: [],
    purpose:
      'Wholly unassigned on a restricted channel — still hidden from non-pool users.',
  },
  {
    key: 'cv_web_vip',
    channelKey: 'ch_web_support',
    externalId: 'rbacdemo-web-004',
    customerName: 'Vũ Thị Lan',
    status: 'open',
    assignedAgentEmail: EMAIL.mgrSupport,
    assignedGroupKey: 'support_tier1',
    tags: ['vip'],
    purpose: 'VIP-tagged, matching the highest-priority routing rule.',
  },
  {
    key: 'cv_sales_assigned',
    channelKey: 'ch_sales_page',
    externalId: 'rbacdemo-fb-001',
    customerName: 'Hoàng Anh Tuấn',
    status: 'open',
    assignedAgentEmail: EMAIL.repNorth1,
    assignedGroupKey: 'sales_north_team',
    tags: [],
    purpose:
      'On the user-restricted channel. repNorth2 is in the same group but NOT in the pool.',
  },
  {
    key: 'cv_sales_unassigned',
    channelKey: 'ch_sales_page',
    externalId: 'rbacdemo-fb-002',
    customerName: 'Bùi Kim Chi',
    status: 'pending',
    assignedAgentEmail: null,
    assignedGroupKey: null,
    tags: [],
    purpose: 'Unassigned on the user-restricted channel.',
  },
  {
    key: 'cv_email_open',
    channelKey: 'ch_shared_email',
    externalId: 'rbacdemo-email-001',
    customerName: 'Phan Quốc Việt',
    status: 'open',
    assignedAgentEmail: null,
    assignedGroupKey: null,
    tags: [],
    purpose:
      'Open channel, unassigned. The control: hidden only by the owner axis, never by the channel axis.',
  },
];

// ABAC policies

export interface PolicySpec {
  name: string;
  description: string;
  resource: string;
  action: string;
  effect: 'allow' | 'deny';
  priority: number;
  /**
   * Conditions, with two seeder-resolved placeholders:
   *   `{{groupId:<groupKey>}}` and `{{userId:<email>}}`.
   */
  conditions: Array<{
    attribute: string;
    operator: string;
    value?: unknown;
    valueAttribute?: string;
  }>;
}

/**
 * Names and descriptions state the business rule, because that is what the
 * Policies screen shows. The authorization property each one demonstrates is in
 * the comment above it.
 */
export const POLICIES: PolicySpec[] = [
  {
    // Resource-attribute deny. Applies to every subject INCLUDING the tenant
    // ADMIN — deny-overrides is absolute by design.
    name: 'Bảo vệ dữ liệu khách hàng VIP',
    description:
      'Khách hàng gắn thẻ VIP chỉ được cập nhật thông qua quy trình phê duyệt riêng, nên mọi thao tác sửa trực tiếp đều bị từ chối.',
    resource: 'contacts',
    action: 'edit',
    effect: 'deny',
    priority: 10,
    conditions: [
      { attribute: 'resource.tags', operator: 'contains', value: 'vip' },
    ],
  },
  {
    // Subject-attribute deny keyed on group membership. Beats the per-user RBAC
    // override that re-granted contacts:delete.
    name: 'Đội Kinh doanh Miền Bắc không được xoá khách hàng',
    description:
      'Nhân sự kinh doanh miền Bắc chỉ cập nhật thông tin khách hàng; việc xoá dữ liệu do trưởng phòng thực hiện.',
    resource: 'contacts',
    action: 'delete',
    effect: 'deny',
    priority: 20,
    conditions: [
      {
        attribute: 'subject.groupIds',
        operator: 'contains',
        value: '{{groupId:sales_north_team}}',
      },
    ],
  },
  {
    // The ALLOW (widening) shape, for reference. Changes nothing on its own: the
    // record layer already defers to RBAC when no deny matches.
    name: 'Cho phép sửa khách hàng do mình phụ trách',
    description:
      'Người phụ trách được phép cập nhật thông tin của khách hàng mình sở hữu.',
    resource: 'contacts',
    action: 'edit',
    effect: 'allow',
    priority: 90,
    conditions: [
      {
        attribute: 'resource.ownerId',
        operator: 'eq',
        valueAttribute: 'subject.id',
      },
    ],
  },
];

// Object ACL entries

export interface AclSpec {
  description: string;
  contactKey: string;
  principalType: 'user' | 'group';
  principalRef: string;
  permissions: string[];
  isDeny: boolean;
}

export const ACLS: AclSpec[] = [
  {
    description:
      'User-scoped deny: the North manager may not edit or delete this one record, even though RBAC grants both.',
    contactKey: 'c-north-mgr',
    principalType: 'user',
    principalRef: EMAIL.mgrNorth,
    permissions: ['edit', 'delete'],
    isDeny: true,
  },
  {
    description:
      'Group-scoped deny: nobody in the North sales team may edit this record, including its owner.',
    contactKey: 'c-north-1',
    principalType: 'group',
    principalRef: 'sales_north_team',
    permissions: ['edit'],
    isDeny: true,
  },
];

// Expectations (what the verifier asserts)

export interface UserExpectation {
  email: string;
  dataScope: DataScope;
  fullAccess: boolean;
  permissions: Record<string, boolean>;
  visibleContacts: string[] | null;
}

const ALL_CONTACTS = CONTACTS.map((row) => row.key);

export const EXPECTATIONS: UserExpectation[] = [
  {
    // Tenant ADMIN.
    email: EMAIL.admin,
    dataScope: DataScope.TENANT,
    fullAccess: true,
    permissions: {
      'contacts:view': true,
      'contacts:delete': true,
      'settings:manage_system': true,
      'users:manage_roles': true,
    },
    visibleContacts: ALL_CONTACTS,
  },
  {
    // Sales director — ORG_UNIT_SUBTREE.
    email: EMAIL.director,
    dataScope: DataScope.ORG_UNIT_SUBTREE,
    fullAccess: false,
    permissions: {
      'contacts:view': true,
      'contacts:delete': true,
      'users:view': true,
      'settings:manage_system': false,
      'tickets:view': false,
    },
    visibleContacts: [
      'c-director',
      'c-north-mgr',
      'c-north-1',
      'c-north-2',
      'c-south',
    ],
  },
  {
    // North sales manager — ORG_UNIT.
    email: EMAIL.mgrNorth,
    dataScope: DataScope.ORG_UNIT,
    fullAccess: false,
    permissions: {
      'contacts:view': true,
      'contacts:delete': true,
      'groups:view': true,
      'users:view': false,
      'tickets:view': false,
    },
    visibleContacts: ['c-north-mgr', 'c-north-1', 'c-north-2'],
  },
  {
    // North rep 1 — group-inherited role, SELF.
    email: EMAIL.repNorth1,
    dataScope: DataScope.SELF,
    fullAccess: false,
    permissions: {
      'contacts:view': true,
      'contacts:edit': true,
      'contacts:delete': false,
      'deals:create': true,
      'deals:delete': false,
    },
    visibleContacts: ['c-north-1'],
  },
  {
    // North rep 2 — override ALLOW.
    email: EMAIL.repNorth2,
    dataScope: DataScope.SELF,
    fullAccess: false,
    permissions: {
      'contacts:view': true,
      // Granted by the override, not by the role.
      'contacts:delete': true,
      'deals:create': true,
    },
    visibleContacts: ['c-north-2'],
  },
  {
    // South rep — override DENY.
    email: EMAIL.repSouth,
    dataScope: DataScope.SELF,
    fullAccess: false,
    permissions: {
      'contacts:view': true,
      'deals:create': false,
      'deals:view': true,
    },
    visibleContacts: ['c-south'],
  },
  {
    // Support manager — ORG_UNIT in the other branch.
    email: EMAIL.mgrSupport,
    dataScope: DataScope.ORG_UNIT,
    fullAccess: false,
    permissions: {
      'tickets:view': true,
      'tickets:delete': true,
      'contacts:view': true,
      'contacts:edit': false,
      'deals:view': false,
    },
    visibleContacts: ['c-support-mgr', 'c-support-1'],
  },
  {
    // Support agent — group-inherited role, SELF.
    email: EMAIL.agentSupport,
    dataScope: DataScope.SELF,
    fullAccess: false,
    permissions: {
      'tickets:view': true,
      'tickets:resolve': true,
      'tickets:delete': false,
      'deals:view': false,
    },
    visibleContacts: ['c-support-1'],
  },
  {
    // Revenue analyst — TENANT scope, read-only.
    email: EMAIL.analyst,
    dataScope: DataScope.TENANT,
    fullAccess: false,
    permissions: {
      'contacts:view': true,
      'contacts:edit': false,
      'deals:view': true,
      'reports:deal:view': true,
      'tickets:edit': false,
    },
    visibleContacts: ALL_CONTACTS,
  },
  {
    // Active time-boxed grant.
    email: EMAIL.jit,
    dataScope: DataScope.SELF,
    fullAccess: false,
    permissions: {
      // Held only through the active time-boxed grant.
      'tickets:view': true,
      'tickets:resolve': true,
      'deals:view': false,
    },
    visibleContacts: [],
  },
  {
    // Expired grant and nothing else.
    email: EMAIL.noGrant,
    dataScope: DataScope.SELF,
    fullAccess: false,
    permissions: {
      'contacts:view': false,
      'deals:view': false,
      'tickets:view': false,
    },
    visibleContacts: null,
  },
];

/**
 * Record-level probes: a PATCH on one contact, and the status it must return.
 *
 * These are the cases resource-level RBAC alone cannot express, so each one
 * names the layer it is proving.
 */
export interface RecordProbe {
  label: string;
  email: string;
  contactKey: string;
  expectedStatus: number;
  layer: 'rbac' | 'abac' | 'object-acl' | 'data-scope';
  expectEmptyBody?: boolean;
}

export const RECORD_PROBES: RecordProbe[] = [
  {
    label: 'owner with contacts:edit is stopped by the group-scoped ACL entry',
    email: EMAIL.repNorth1,
    contactKey: 'c-north-1',
    expectedStatus: 403,
    layer: 'object-acl',
  },
  {
    label: 'North manager is denied on the record by a user-scoped ACL entry',
    email: EMAIL.mgrNorth,
    contactKey: 'c-north-mgr',
    expectedStatus: 403,
    layer: 'object-acl',
  },
  {
    label: 'North manager is denied on the VIP record in their own unit',
    email: EMAIL.mgrNorth,
    contactKey: 'c-north-2',
    expectedStatus: 403,
    layer: 'abac',
  },
  {
    label:
      'owner of the VIP contact is denied by the resource-attribute policy',
    email: EMAIL.repNorth2,
    contactKey: 'c-north-2',
    expectedStatus: 403,
    layer: 'abac',
  },
  {
    label: 'tenant ADMIN is also denied by the VIP policy (deny-overrides)',
    email: EMAIL.admin,
    contactKey: 'c-north-2',
    expectedStatus: 403,
    layer: 'abac',
  },
  {
    label: 'ADMIN can patch a contact with no policy or ACL against it',
    email: EMAIL.admin,
    contactKey: 'c-support-1',
    expectedStatus: 200,
    layer: 'rbac',
  },
  {
    // This expectation used to be `200` with an empty body, which pinned a real
    // defect: a write refused by data-visibility was reported as success. It
    // then silently became `409 modified by another request`, because the
    // contacts PATCH path derives its optimistic-lock version from a
    // visibility-scoped pre-read that returned nothing. Both answers were wrong
    // about the same thing — the record is not this caller's to edit.
    label:
      'South rep write to a North record is refused — out of data scope (404, record untouched)',
    email: EMAIL.repSouth,
    contactKey: 'c-north-1',
    expectedStatus: 404,
    layer: 'data-scope',
  },
  {
    label: 'South rep can patch the contact they own',
    email: EMAIL.repSouth,
    contactKey: 'c-south',
    expectedStatus: 200,
    layer: 'rbac',
  },
  {
    label: 'analyst has tenant-wide read but no contacts:edit',
    email: EMAIL.analyst,
    contactKey: 'c-south',
    expectedStatus: 403,
    layer: 'rbac',
  },
  {
    label: 'support manager cannot patch a sales record (no contacts:edit)',
    email: EMAIL.mgrSupport,
    contactKey: 'c-support-1',
    expectedStatus: 403,
    layer: 'rbac',
  },
];

/** Module-level probes: GET a list endpoint, assert allow/deny. */
export interface RouteProbe {
  label: string;
  email: string;
  path: string;
  expectedStatus: number;
}

export const ROUTE_PROBES: RouteProbe[] = [
  {
    label: 'support agent has no deals module',
    email: EMAIL.agentSupport,
    path: '/deals?limit=1',
    expectedStatus: 403,
  },
  {
    label: 'sales rep has no tickets module',
    email: EMAIL.repNorth1,
    path: '/tickets?limit=1',
    expectedStatus: 403,
  },
  {
    label: 'analyst cannot list users',
    email: EMAIL.analyst,
    path: '/users?page=1&limit=1',
    expectedStatus: 403,
  },
  {
    label: 'director can list users',
    email: EMAIL.director,
    path: '/users?page=1&limit=1',
    expectedStatus: 200,
  },
  {
    label: 'no-grant account is rejected on every module',
    email: EMAIL.noGrant,
    path: '/contacts?limit=1',
    expectedStatus: 403,
  },
  {
    label: 'JIT account reaches tickets through its time-boxed grant',
    email: EMAIL.jit,
    path: '/tickets?limit=1',
    expectedStatus: 200,
  },
  {
    label: 'JIT account still has no deals access',
    email: EMAIL.jit,
    path: '/deals?limit=1',
    expectedStatus: 403,
  },
  {
    label:
      'sales rep has no omni module (omni no longer rides on contacts:view)',
    email: EMAIL.repSouth,
    path: '/omni/conversations?limit=1',
    expectedStatus: 403,
  },
  {
    label: 'support agent reaches the omni inbox',
    email: EMAIL.agentSupport,
    path: '/omni/conversations?limit=1',
    expectedStatus: 200,
  },
  {
    label: 'support agent cannot edit a channel support pool',
    email: EMAIL.agentSupport,
    path: '/channels',
    expectedStatus: 403,
  },
];

// Omni conversation visibility

/**
 * Which conversations each principal may list.
 *
 * Two axes are in play and they are independent: the channel axis (is this
 * principal in the channel's support pool?) and the owner axis (is the
 * conversation assigned to them, their subordinates or their group?). A row
 * appears only when BOTH admit it, which is why the expectations below are
 * narrower than either axis alone would suggest.
 *
 * `null` means the account cannot reach the endpoint at all.
 */
export interface ConversationExpectation {
  email: string;
  visibleConversations: string[] | null;
  note: string;
}

export const CONVERSATION_EXPECTATIONS: ConversationExpectation[] = [
  {
    email: EMAIL.admin,
    visibleConversations: CONVERSATIONS.map((c) => c.key),
    note: 'Tenant ADMIN bypasses both axes.',
  },
  {
    email: EMAIL.agentSupport,
    visibleConversations: [
      'cv_web_assigned_agent',
      'cv_web_group_queue',
      'cv_web_vip',
    ],
    note:
      'In the web channel pool via CSKH Tầng 1. Sees their own row, the group queue ' +
      'and the manager-assigned VIP row (same group). Not cv_web_unassigned — no group, ' +
      'no agent. Not the sales channel — outside its pool.',
  },
  {
    email: EMAIL.mgrSupport,
    visibleConversations: [
      'cv_web_assigned_agent',
      'cv_web_group_queue',
      'cv_web_vip',
    ],
    note: 'ORG_UNIT scope over the support unit, and in the web pool through the same group.',
  },
  // repNorth1 / repNorth2 USED to be listed here with a visible conversation
  // set, which the fixture cannot express: all three sales accounts share
  // `sales_rep_self`, and MODULE_PROBES asserts (correctly, and load-bearingly)
  // that repSouth gets 403 on /omni/conversations because omni no longer rides
  // on `contacts:view`. One role cannot both carry and not carry
  // `omni_channel:view`, so those two entries could only ever fail.
  //
  // The read side of the channel axis is therefore covered by the support
  // accounts below, and the user-pool semantics repNorth2 was there to prove —
  // "same group, but not in the pool" — are still covered by ASSIGNMENT_PROBES.
  // Restoring read coverage for a pooled sales rep needs a second sales role
  // with `omni_channel:view`; that is a fixture design decision, not a
  // product one.
  {
    email: EMAIL.repNorth1,
    visibleConversations: null,
    note: 'Shares sales_rep_self, which has no omni_channel:view — the module is closed.',
  },
  {
    email: EMAIL.repNorth2,
    visibleConversations: null,
    note: 'Same role as repNorth1; the omni module is closed before the channel axis is reached.',
  },
  {
    email: EMAIL.analyst,
    visibleConversations: null,
    note: 'TENANT data scope but no omni_channel:view — the module is closed.',
  },
];

/**
 * Assignment probes: PATCH /omni/conversations/:key/assign, and the status the
 * channel support pool must produce.
 */
export interface AssignmentProbe {
  label: string;
  email: string;
  conversationKey: string;
  /** Target agent, by email. */
  targetEmail: string;
  expectedStatus: number;
}

export const ASSIGNMENT_PROBES: AssignmentProbe[] = [
  {
    label: 'support manager assigns within the channel pool',
    email: EMAIL.mgrSupport,
    conversationKey: 'cv_web_group_queue',
    targetEmail: EMAIL.agentSupport,
    expectedStatus: 200,
  },
  {
    label:
      'ADMIN cannot assign a sales rep to a support channel — the pool binds even the admin',
    email: EMAIL.admin,
    conversationKey: 'cv_web_group_queue',
    targetEmail: EMAIL.repNorth1,
    expectedStatus: 403,
  },
  {
    label:
      'ADMIN cannot assign repNorth2 to the sales page — same group, but not in the user pool',
    email: EMAIL.admin,
    conversationKey: 'cv_sales_unassigned',
    targetEmail: EMAIL.repNorth2,
    expectedStatus: 403,
  },
  {
    label: 'ADMIN assigns anyone on the open channel',
    email: EMAIL.admin,
    conversationKey: 'cv_email_open',
    targetEmail: EMAIL.repSouth,
    expectedStatus: 200,
  },
];
