import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GraphQLError } from "graphql";
import type {
  AuditLog,
  Clarification,
  Clause,
  ComplianceStatus,
  ReviewDatabase,
  ReviewRole,
  ReviewVersion,
  ReviewerOpinion,
  SupplierResponse,
} from "./types";

export const VERSION_CONFLICT_CODE = "REVIEW_VERSION_CONFLICT";

const clauses: Clause[] = [
  {
    id: "C001",
    code: "A.1",
    title: "实施组织与项目计划",
    category: "实施能力",
    requirement:
      "投标人应明确项目组织、职责界面、实施方法、进度控制和风险应对机制。",
    type: "mandatory",
    weight: 0,
    evidenceRequired: true,
    order: 1,
  },
  {
    id: "C002",
    code: "A.1.1",
    title: "项目经理及关键人员",
    category: "实施能力",
    requirement:
      "项目经理应具备五年以上同类项目经验，关键人员配置应覆盖架构、开发、测试与安全。",
    type: "mandatory",
    weight: 0,
    parentId: "C001",
    evidenceRequired: true,
    order: 2,
  },
  {
    id: "C003",
    code: "A.1.2",
    title: "实施进度与里程碑",
    category: "实施能力",
    requirement:
      "提供可核验的里程碑、交付物、验收条件和资源投入计划。",
    type: "scoring",
    weight: 15,
    parentId: "C001",
    evidenceRequired: false,
    order: 3,
  },
  {
    id: "C004",
    code: "B.1",
    title: "技术架构与互操作性",
    category: "技术方案",
    requirement:
      "系统架构应支持模块化部署、横向扩展，并与采购人现有平台实现稳定互操作。",
    type: "scoring",
    weight: 25,
    evidenceRequired: true,
    order: 4,
  },
  {
    id: "C005",
    code: "B.1.1",
    title: "接口开放与标准协议",
    category: "技术方案",
    requirement:
      "对外接口应遵循 HTTPS、OAuth 2.0 和 OpenAPI 3.x，提供版本兼容与错误码说明。",
    type: "mandatory",
    weight: 0,
    parentId: "C004",
    evidenceRequired: true,
    order: 5,
  },
  {
    id: "C006",
    code: "B.1.2",
    title: "国产化兼容性",
    category: "技术方案",
    requirement:
      "提供操作系统、数据库、中间件及浏览器兼容性矩阵，并说明适配边界。",
    type: "scoring",
    weight: 15,
    parentId: "C004",
    evidenceRequired: true,
    order: 6,
  },
  {
    id: "C007",
    code: "C.1",
    title: "安全保障",
    category: "安全与合规",
    requirement:
      "技术方案应覆盖身份鉴别、访问控制、审计、数据保护和安全运维。",
    type: "mandatory",
    weight: 0,
    evidenceRequired: true,
    order: 7,
  },
  {
    id: "C008",
    code: "C.1.1",
    title: "等级保护三级证明材料",
    category: "安全与合规",
    requirement:
      "提供有效的网络安全等级保护三级备案证明或第三方测评结论。",
    type: "evidence",
    weight: 0,
    parentId: "C007",
    evidenceRequired: true,
    order: 8,
  },
  {
    id: "C009",
    code: "C.1.2",
    title: "漏洞响应机制",
    category: "安全与合规",
    requirement:
      "说明漏洞发现、分级、修复、复测和重大事件通报时限。",
    type: "scoring",
    weight: 15,
    parentId: "C007",
    evidenceRequired: false,
    order: 9,
  },
  {
    id: "C010",
    code: "D.1",
    title: "服务与培训",
    category: "服务保障",
    requirement:
      "提供驻场、巡检、培训、知识转移和故障升级的服务方案及量化响应指标。",
    type: "scoring",
    weight: 20,
    evidenceRequired: false,
    order: 10,
  },
  {
    id: "C011",
    code: "D.2",
    title: "验收指标",
    category: "服务保障",
    requirement:
      "验收指标应可测量、可复现，并与采购需求中的服务水平保持一致。",
    type: "mandatory",
    weight: 0,
    evidenceRequired: true,
    order: 11,
  },
];

const suppliers = [
  { id: "SUP-A", name: "华云数科" },
  { id: "SUP-B", name: "北辰信息" },
  { id: "SUP-C", name: "南岭科技" },
];

const responseOverrides: Record<
  string,
  Partial<
    Pick<
      SupplierResponse,
      "status" | "claimedScore" | "attachmentName" | "proofFingerprint"
    >
  >
> = {
  "C001-SUP-A": {
    status: "compliant",
    claimedScore: 0,
    attachmentName: "项目组织方案.pdf",
    proofFingerprint: "PROOF-PLAN-A",
  },
  "C001-SUP-B": {
    status: "compliant",
    claimedScore: 0,
    attachmentName: "实施组织与计划.pdf",
    proofFingerprint: "PROOF-PLAN-B",
  },
  "C001-SUP-C": {
    status: "clarification",
    claimedScore: 0,
    attachmentName: "项目管理说明.pdf",
    proofFingerprint: "PROOF-PLAN-C",
  },
  "C005-SUP-A": {
    status: "compliant",
    claimedScore: 0,
    attachmentName: "安全测评报告.pdf",
    proofFingerprint: "PROOF-SEC-CERT-2026",
  },
  "C005-SUP-B": {
    status: "deviation",
    claimedScore: 0,
    attachmentName: "接口兼容说明.pdf",
    proofFingerprint: "PROOF-API-B",
  },
  "C008-SUP-A": {
    status: "compliant",
    claimedScore: 0,
    attachmentName: "等保三级备案证明.pdf",
    proofFingerprint: "PROOF-SEC-CERT-2026",
  },
  "C008-SUP-B": {
    status: "clarification",
    claimedScore: 0,
    attachmentName: "等保材料说明.pdf",
    proofFingerprint: "PROOF-SEC-B",
  },
  "C010-SUP-B": {
    status: "compliant",
    claimedScore: 16,
    attachmentName: "服务方案.pdf",
    proofFingerprint: "PROOF-SERVICE-B",
  },
};

const reviewFactories: Array<{
  responseId: string;
  reviewer: string;
  role: ReviewRole;
  decision: ComplianceStatus;
  score: number;
  comment: string;
  createdAt: string;
}> = [
  {
    responseId: "C002-SUP-A",
    reviewer: "陈评审",
    role: "reviewer_a",
    decision: "compliant",
    score: 0,
    comment: "人员履历满足年限要求，社保材料与履历能够对应。",
    createdAt: "2026-09-28T09:10:00+08:00",
  },
  {
    responseId: "C002-SUP-A",
    reviewer: "李评审",
    role: "reviewer_b",
    decision: "clarification",
    score: 0,
    comment: "安全负责人项目经历需补充合同页或验收证明。",
    createdAt: "2026-09-28T10:25:00+08:00",
  },
  {
    responseId: "C003-SUP-A",
    reviewer: "陈评审",
    role: "reviewer_a",
    decision: "compliant",
    score: 13,
    comment: "里程碑和交付物完整，风险缓冲充分。",
    createdAt: "2026-09-28T11:10:00+08:00",
  },
  {
    responseId: "C003-SUP-A",
    reviewer: "李评审",
    role: "reviewer_b",
    decision: "compliant",
    score: 10,
    comment: "计划完整，但关键人员投入比例未量化。",
    createdAt: "2026-09-28T11:40:00+08:00",
  },
  {
    responseId: "C004-SUP-B",
    reviewer: "陈评审",
    role: "reviewer_a",
    decision: "compliant",
    score: 21,
    comment: "架构分层清晰，现有系统适配路径可验证。",
    createdAt: "2026-09-28T13:15:00+08:00",
  },
  {
    responseId: "C004-SUP-B",
    reviewer: "李评审",
    role: "reviewer_b",
    decision: "deviation",
    score: 15,
    comment: "高可用部署缺少跨机房切换演练记录。",
    createdAt: "2026-09-28T14:02:00+08:00",
  },
];

const clarificationFactories: Clarification[] = [
  {
    id: "CL-001",
    responseId: "C002-SUP-A",
    clauseId: "C002",
    versionId: "",
    round: 1,
    requestText: "补充安全负责人近五年的同类项目合同页或验收证明。",
    requestedAt: "2026-09-27T09:00:00+08:00",
    dueAt: "2026-09-28T18:00:00+08:00",
    status: "overdue",
  },
  {
    id: "CL-002",
    responseId: "C008-SUP-B",
    clauseId: "C008",
    versionId: "",
    round: 1,
    requestText: "提供等保测评结论页及有效期说明。",
    requestedAt: "2026-09-28T14:30:00+08:00",
    dueAt: "2026-10-02T18:00:00+08:00",
    status: "open",
  },
  {
    id: "CL-003",
    responseId: "C009-SUP-C",
    clauseId: "C009",
    versionId: "",
    round: 2,
    requestText: "补充重大漏洞四小时通报的流程截图。",
    supplierResponse: "已补充值班表、升级路径和平台告警截图。",
    requestedAt: "2026-09-26T15:00:00+08:00",
    dueAt: "2026-09-28T18:00:00+08:00",
    respondedAt: "2026-09-27T14:20:00+08:00",
    status: "responded",
  },
];

const makeResponse = (
  clause: Clause,
  supplierIndex: number,
  clauseIndex: number,
  draftVersionId: string,
): SupplierResponse => {
  const supplier = suppliers[supplierIndex];
  const id = `${clause.id}-${supplier.id}`;
  const defaultStatus: ComplianceStatus = clause.type === "mandatory" ? "compliant" : "pending";
  const maxScore = clause.weight;
  const scorePattern = [
    Math.round(maxScore * 0.8),
    Math.round(maxScore * 0.72),
    Math.round(maxScore * 0.64),
  ];
  const override = responseOverrides[id] ?? {};
  const base: SupplierResponse = {
    id,
    clauseId: clause.id,
    supplierId: supplier.id,
    supplierName: supplier.name,
    status: override.status ?? defaultStatus,
    responseText:
      clause.type === "mandatory"
        ? `${supplier.name}已按采购要求提交说明与支持材料。`
        : `${supplier.name}提交响应正文，并声明可满足条款要求，分值依据需评审员复核。`,
    claimedScore: override.claimedScore ?? scorePattern[supplierIndex] ?? 0,
    attachmentName:
      override.attachmentName ?? `${supplier.name}-${clause.code}-证明材料.pdf`,
    proofFingerprint:
      override.proofFingerprint ?? `PROOF-${clause.id}-${supplier.id}`,
    submittedBy: `${supplier.name}投标专员`,
    submittedAt: `2026-09-${String(22 + ((clauseIndex + supplierIndex) % 4)).padStart(2, "0")}T16:20:00+08:00`,
    reviewRound: 1,
    reviews: [],
    clarifications: [],
  };
  base.reviews = reviewFactories
    .filter((item) => item.responseId === id)
    .map((item, index) => ({
      id: `OP-${id}-${index + 1}`,
      ...item,
      versionId: draftVersionId,
    })) as ReviewerOpinion[];
  base.clarifications = clarificationFactories
    .filter((item) => item.responseId === id)
    .map((item) => ({ ...item, versionId: draftVersionId }));
  return base;
};

const DRAFT_VERSION_ID = "VER-002";

const makeVersions = (responseCount: number): ReviewVersion[] => [
  {
    id: "VER-001",
    version: "V1",
    label: "初审问题定位版本",
    status: "finalized",
    createdAt: "2026-09-25T17:30:00+08:00",
    createdBy: "采购工作组",
    signedBy: ["采购负责人", "技术评审组长"],
    clauseCount: clauses.length,
    responseCount,
    contentHash: "a84f2d17",
    snapshot: {
      contentHash: "a84f2d17",
      opinionCount: 0,
      clarificationCount: 0,
      responses: [],
    },
  },
  {
    id: DRAFT_VERSION_ID,
    version: "V2",
    label: "澄清与评分复核工作版",
    status: "draft",
    createdAt: "2026-09-29T08:10:00+08:00",
    createdBy: "采购工作组",
    signedBy: [],
    clauseCount: clauses.length,
    responseCount,
    contentHash: "",
    snapshot: null,
  },
];

const auditLogs: AuditLog[] = [
  {
    id: "AUD-001",
    at: "2026-09-25T17:30:00+08:00",
    actor: "采购负责人",
    action: "版本定稿",
    entity: "VER-001",
    detail: "初审问题定位版本签署锁定，共覆盖 11 条技术条款。",
  },
  {
    id: "AUD-002",
    at: "2026-09-27T09:00:00+08:00",
    actor: "采购专员",
    action: "发起澄清",
    entity: "CL-001",
    detail: "要求华云数科补充关键人员项目经历证明。",
  },
  {
    id: "AUD-003",
    at: "2026-09-28T10:25:00+08:00",
    actor: "李评审",
    action: "提交独立意见",
    entity: "C002-SUP-A",
    detail: "建议待澄清，与陈评审的符合结论形成分歧。",
  },
  {
    id: "AUD-004",
    at: "2026-09-29T08:10:00+08:00",
    actor: "采购工作组",
    action: "创建工作版本",
    entity: "VER-002",
    detail: "创建 V2 工作版本，保留 V1 定稿快照。",
  },
];

const buildSeed = (): ReviewDatabase => {
  const builtResponses = clauses.flatMap((clause, clauseIndex) =>
    suppliers.map((_supplier, supplierIndex) =>
      makeResponse(clause, supplierIndex, clauseIndex, DRAFT_VERSION_ID),
    ),
  );
  return {
    clauses: structuredClone(clauses),
    responses: builtResponses,
    versions: makeVersions(builtResponses.length),
    auditLogs: structuredClone(auditLogs),
    suppliers: structuredClone(suppliers),
    revision: 1,
    processedMutations: [],
  };
};

/**
 * 旧数据没有版本归属：把没有 versionId 的意见和澄清迁移到当前草稿，
 * 补齐快照、revision 和幂等记录字段，保证历史 runtime-data 也能被正确读取。
 * 返回是否发生迁移，调用方据此把结果落盘。
 */
const migrate = (database: ReviewDatabase): boolean => {
  let changed = false;
  const draft = database.versions.find((version) => version.status === "draft");
  if (!draft) {
    return false;
  }
  database.responses.forEach((response) => {
    response.reviews.forEach((opinion) => {
      if (!opinion.versionId) {
        opinion.versionId = draft.id;
        changed = true;
      }
    });
    response.clarifications.forEach((clarification) => {
      if (!clarification.versionId) {
        clarification.versionId = draft.id;
        changed = true;
      }
    });
  });
  database.versions.forEach((version) => {
    if (version.status === "finalized" && !version.snapshot) {
      version.snapshot = {
        contentHash: version.contentHash,
        opinionCount: 0,
        clarificationCount: 0,
        responses: [],
      };
      changed = true;
    }
    if (version.status === "draft" && version.snapshot !== null) {
      version.snapshot = null;
      changed = true;
    }
  });
  if (typeof database.revision !== "number") {
    database.revision = 1;
    changed = true;
  }
  if (!Array.isArray(database.processedMutations)) {
    database.processedMutations = [];
    changed = true;
  }
  if (changed) {
    database.revision += 1;
  }
  return changed;
};

/** 客户端基于旧版本数据提交时抛出，前端收到此错误后必须重新载入。 */
export class ReviewVersionConflictError extends GraphQLError {
  constructor(message: string) {
    super(message, { extensions: { code: VERSION_CONFLICT_CODE } });
    this.name = "ReviewVersionConflictError";
  }
}

class ReviewDataStore {
  private readonly runtimePath = join(process.cwd(), "server", "runtime-data.json");
  private data: ReviewDatabase;
  /** 所有 mutation 串行排队，评审员同时提交时后一个读到的是前一个提交后的服务端数据。 */
  private chain: Promise<unknown> = Promise.resolve();

  constructor() {
    if (existsSync(this.runtimePath)) {
      try {
        const loaded = JSON.parse(
          readFileSync(this.runtimePath, "utf8"),
        ) as ReviewDatabase;
        const migrated = migrate(loaded);
        this.data = loaded;
        if (migrated) {
          // 迁移结果立即落盘，避免旧归属缺失在每次重启时重复处理。
          writeFileSync(
            this.runtimePath,
            JSON.stringify(this.data, null, 2),
            "utf8",
          );
        }
      } catch {
        this.data = buildSeed();
      }
    } else {
      this.data = buildSeed();
    }
  }

  snapshot(): ReviewDatabase {
    return structuredClone(this.data);
  }

  currentDraft(): ReviewVersion {
    const draft = this.data.versions.find((version) => version.status === "draft");
    if (!draft) {
      throw new ReviewVersionConflictError(
        "当前评审版本已定稿，请重新载入评审数据后在新草稿中操作。",
      );
    }
    return draft;
  }

  /**
   * 以串行事务方式修改数据。同一 clientMutationId 的重试不再执行 work，
   * 而是通过 findReplay 取回首次入库的实体，保证同一意见只入库一次。
   * 返回值同时带服务端 revision，供前端丢弃过期刷新。
   */
  mutate<T>(
    clientMutationId: string,
    work: (database: ReviewDatabase) => T,
    findReplay?: (database: ReviewDatabase) => T,
  ): Promise<{ result: T; revision: number; replayed: boolean }> {
    const run = this.chain.then(() => {
      if (clientMutationId && this.data.processedMutations.includes(clientMutationId)) {
        if (!findReplay) {
          throw new Error("重复提交缺少幂等回放查询。");
        }
        return {
          result: findReplay(this.data),
          revision: this.data.revision,
          replayed: true as const,
        };
      }
      const result = work(this.data);
      this.data.revision += 1;
      if (clientMutationId) {
        this.data.processedMutations.push(clientMutationId);
        if (this.data.processedMutations.length > 200) {
          this.data.processedMutations = this.data.processedMutations.slice(-200);
        }
      }
      writeFileSync(this.runtimePath, JSON.stringify(this.data, null, 2), "utf8");
      return { result, revision: this.data.revision, replayed: false as const };
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  reset(): ReviewDatabase {
    this.data = buildSeed();
    writeFileSync(this.runtimePath, JSON.stringify(this.data, null, 2), "utf8");
    return this.snapshot();
  }
}

export const reviewDataStore = new ReviewDataStore();

export const createAudit = (
  database: ReviewDatabase,
  actor: string,
  action: string,
  entity: string,
  detail: string,
): void => {
  database.auditLogs.unshift({
    id: `AUD-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    at: new Date().toISOString(),
    actor,
    action,
    entity,
    detail,
  });
};

export const createOpinionId = (): string =>
  `OP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

export const createClarificationId = (): string =>
  `CL-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

export const createVersionId = (): string =>
  `VER-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
