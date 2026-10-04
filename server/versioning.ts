import { createHash } from "node:crypto";
import type {
  Clarification,
  ComplianceStatus,
  ReviewDatabase,
  ReviewerOpinion,
  ReviewVersion,
  SupplierResponse,
} from "./types";

/** 版本冲突错误：客户端依据的草稿已被其他提交或定稿推进。 */
export const VERSION_CONFLICT_CODE = "VERSION_CONFLICT";

export class VersionConflictError extends Error {
  readonly code = VERSION_CONFLICT_CODE;

  constructor(message: string) {
    super(message);
    this.name = "VersionConflictError";
  }
}

export const isVersionConflict = (error: unknown): boolean =>
  error instanceof VersionConflictError;

export const findDraftVersion = (
  database: ReviewDatabase,
): ReviewVersion | undefined =>
  database.versions.find((version) => version.status === "draft");

/** 概览、比对和导出统一以当前草稿（无草稿时回退到最新版本）为口径。 */
export const findActiveVersion = (
  database: ReviewDatabase,
): ReviewVersion | undefined =>
  findDraftVersion(database) ?? database.versions[0];

export const versionOpinions = (
  database: ReviewDatabase,
  versionId: string,
): ReviewerOpinion[] =>
  database.responses.flatMap((response) =>
    response.reviews.filter((review) => review.versionId === versionId),
  );

export const versionClarifications = (
  database: ReviewDatabase,
  versionId: string,
): Clarification[] =>
  database.responses.flatMap((response) =>
    response.clarifications.filter(
      (clarification) => clarification.versionId === versionId,
    ),
  );

export const isClarificationBlocking = (
  clarification: Clarification,
): boolean =>
  clarification.status === "open" || clarification.status === "overdue";

export const hasOpinionDifference = (reviews: ReviewerOpinion[]): boolean => {
  const decisions = new Set(
    reviews
      .filter((review) => review.decision !== "clarification")
      .map((review) => review.decision),
  );
  return decisions.size > 1;
};

/**
 * 按服务端此刻数据计算某个版本的快照统计。
 * 定稿版本用锁定值，草稿用实时值，保证概览/比对/导出读到同一口径。
 */
export const computeVersionStats = (
  database: ReviewDatabase,
  versionId: string,
): Pick<
  ReviewVersion,
  | "clauseCount"
  | "responseCount"
  | "opinionCount"
  | "clarificationCount"
  | "pendingClarificationCount"
  | "differenceCount"
  | "reviewedResponseCount"
> => {
  let opinionCount = 0;
  let clarificationCount = 0;
  let pendingClarificationCount = 0;
  let differenceCount = 0;
  let reviewedResponseCount = 0;

  for (const response of database.responses) {
    const reviews = response.reviews.filter(
      (review) => review.versionId === versionId,
    );
    const clarifications = response.clarifications.filter(
      (clarification) => clarification.versionId === versionId,
    );
    opinionCount += reviews.length;
    clarificationCount += clarifications.length;
    if (reviews.length > 0) {
      reviewedResponseCount += 1;
    }
    if (hasOpinionDifference(reviews)) {
      differenceCount += 1;
    }
    if (clarifications.some(isClarificationBlocking)) {
      pendingClarificationCount += 1;
    }
  }

  return {
    clauseCount: database.clauses.length,
    responseCount: database.responses.length,
    opinionCount,
    clarificationCount,
    pendingClarificationCount,
    differenceCount,
    reviewedResponseCount,
  };
};

/** 草稿的统计随提交实时计算；定稿版本返回锁定快照。 */
export const decorateVersion = (
  database: ReviewDatabase,
  version: ReviewVersion,
): ReviewVersion => {
  if (version.status === "finalized") {
    return version;
  }
  return { ...version, ...computeVersionStats(database, version.id) };
};

/** 依据当前版本的独立意见和澄清推导响应状态，不再写入共享字段污染快照。 */
export const deriveResponseStatus = (
  response: SupplierResponse,
  versionId: string,
): ComplianceStatus => {
  const clarifications = response.clarifications.filter(
    (clarification) => clarification.versionId === versionId,
  );
  if (clarifications.some((item) => item.status === "open")) {
    return "clarification";
  }
  if (clarifications.some((item) => item.status === "overdue")) {
    return "clarification";
  }
  const reviews = response.reviews.filter(
    (review) => review.versionId === versionId,
  );
  if (reviews.length === 0) {
    return "pending";
  }
  const latest = [...reviews].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  )[0];
  return latest.decision;
};

/**
 * 按定稿时刻服务端数据生成确定性内容哈希：
 * 同一份评审内容哈希不变（时间戳等易变量不参与），
 * 定稿后再补意见也不会改变历史快照。
 */
export const hashSnapshot = (
  database: ReviewDatabase,
  versionId: string,
): string => {
  const payload = {
    versionId,
    clauses: database.clauses.map((clause) => clause.id),
    responses: database.responses.map((response) => ({
      id: response.id,
      reviews: response.reviews
        .filter((review) => review.versionId === versionId)
        .map((review) => [
          review.reviewer,
          review.role,
          review.decision,
          review.score,
          review.comment,
        ]),
      clarifications: response.clarifications
        .filter((clarification) => clarification.versionId === versionId)
        .map((clarification) => [
          clarification.round,
          clarification.status,
          clarification.requestText,
          clarification.supplierResponse ?? "",
        ]),
    })),
  };
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 12);
};

const nextVersionNumber = (database: ReviewDatabase): number =>
  database.versions.reduce((maximum, version) => {
    const numeric = Number(version.version.replace(/\D/g, ""));
    return Number.isFinite(numeric) ? Math.max(maximum, numeric) : maximum;
  }, 0) + 1;

/** 定稿后创建承接后续意见的新草稿，旧快照不再被覆盖。 */
export const createDraftVersion = (
  database: ReviewDatabase,
  actor: string,
  now: Date,
): ReviewVersion => {
  const number = nextVersionNumber(database);
  const version: ReviewVersion = {
    id: `VER-DRAFT-${now.getTime()}`,
    version: `V${number}`,
    label: "后续评审工作版",
    status: "draft",
    createdAt: now.toISOString(),
    createdBy: actor,
    signedBy: [],
    clauseCount: database.clauses.length,
    responseCount: database.responses.length,
    opinionCount: 0,
    clarificationCount: 0,
    pendingClarificationCount: 0,
    differenceCount: 0,
    reviewedResponseCount: 0,
    revision: 1,
    contentHash: "",
  };
  return version;
};

/**
 * 校验客户端的乐观并发参数：
 * 版本必须仍是草稿，ID 和修订号都要匹配，否则要求重新载入。
 */
export const requireOpenDraft = (
  database: ReviewDatabase,
  versionId: string,
  expectedRevision: number,
): ReviewVersion => {
  const draft = findDraftVersion(database);
  if (!draft) {
    throw new VersionConflictError(
      "当前没有可提交的工作草稿，请重新载入后再操作。",
    );
  }
  if (draft.id !== versionId) {
    throw new VersionConflictError(
      "评审版本已被组长定稿锁定，请重新载入当前工作版后再提交。",
    );
  }
  if (draft.revision !== expectedRevision) {
    throw new VersionConflictError(
      "其他评审员已先一步提交，评审数据已更新，请重新载入后重试。",
    );
  }
  return draft;
};

/**
 * 旧数据迁移：没有版本归属的意见、澄清和审计记录
 * 统一归入当前草稿，保证后续快照和计数不丢历史。
 */
export const migrateLegacyData = (database: ReviewDatabase): void => {
  let draft = findDraftVersion(database);
  if (!draft) {
    draft = createDraftVersion(database, "系统迁移", new Date());
    database.versions.unshift(draft);
  }

  for (const response of database.responses) {
    for (const review of response.reviews) {
      if (!review.versionId) {
        review.versionId = draft.id;
      }
      delete review.clientToken;
    }
    for (const clarification of response.clarifications) {
      if (!clarification.versionId) {
        clarification.versionId = draft.id;
      }
      delete clarification.clientToken;
      delete clarification.responseToken;
    }
  }

  for (const log of database.auditLogs) {
    if (!log.versionId) {
      log.versionId = "unassigned";
    }
  }

  database.versions.forEach((version) => {
    if (typeof version.revision !== "number") {
      version.revision = 1;
    }
    const stats = computeVersionStats(database, version.id);
    version.opinionCount ??= stats.opinionCount;
    version.clarificationCount ??= stats.clarificationCount;
    version.pendingClarificationCount ??= stats.pendingClarificationCount;
    version.differenceCount ??= stats.differenceCount;
    version.reviewedResponseCount ??= stats.reviewedResponseCount;
    if (version.status === "draft") {
      Object.assign(version, stats);
      version.contentHash = "";
    }
  });
};
