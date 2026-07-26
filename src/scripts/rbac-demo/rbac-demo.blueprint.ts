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

// ── Org units ───────────────────────────────────────────────────────────────

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

// ── Custom roles ────────────────────────────────────────────────────────────

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
  'contacts:delete',
  'accounts:delete',
  'deals:delete',
  'tasks:delete',
  'reports:contact:view',
  'groups:view',
];

const SUPPORT_AGENT_PERMISSIONS = [
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

// ── Groups ──────────────────────────────────────────────────────────────────

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
    memberEmails: [EMAIL.agentSupport],
  },
  {
    key: 'revenue_analysts',
    name: 'Nhóm Phân tích Doanh thu',
    description: 'Bộ phận phân tích số liệu doanh thu toàn công ty.',
    roleKeys: ['revenue_analyst_tenant'],
    memberEmails: [EMAIL.analyst],
  },
];

// ── Users ───────────────────────────────────────────────────────────────────

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

// ── Contact fixtures (the rows data scope is measured on) ────────────────────

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

// ── ABAC policies ───────────────────────────────────────────────────────────

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

// ── Object ACL entries ──────────────────────────────────────────────────────

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

// ── Expectations (what the verifier asserts) ────────────────────────────────

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
    label:
      'South rep write to a North record is a no-op — out of data scope (200 + empty body, record untouched)',
    email: EMAIL.repSouth,
    contactKey: 'c-north-1',
    expectedStatus: 200,
    expectEmptyBody: true,
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
];
