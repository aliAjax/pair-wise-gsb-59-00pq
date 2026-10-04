import { ApolloServer } from "@apollo/server";
import { startStandaloneServer } from "@apollo/server/standalone";
import {
  createAudit,
  createClarificationId,
  createOpinionId,
  reviewDataStore,
} from "./data";
import { typeDefs } from "./schema";
import type {
  AssessmentInput,
  ClarificationInput,
  ClarificationResponseInput,
  Clause,
  DashboardStats,
  FinalizeVersionInput,
  ReviewDatabase,
  ReviewRole,
  ReviewVersion,
} from "./types";
import {
  VersionConflictError,
  computeVersionStats,
  createDraftVersion,
  decorateVersion,
  deriveResponseStatus,
  findActiveVersion,
  hashSnapshot,
  isClarificationBlocking,
  requireOpenDraft,
  versionClarifications,
} from "./versioning";

const getDashboard = (database: ReviewDatabase): DashboardStats => {
  const activeVersion = findActiveVersion(database);
  const stats = activeVersion
    ? computeVersionStats(database, activeVersion.id)
    : {
        clauseCount: database.clauses.length,
        responseCount: database.responses.length,
        opinionCount: 0,
        clarificationCount: 0,
        pendingClarificationCount: 0,
        differenceCount: 0,
        reviewedResponseCount: 0,
      };

  const proofCounts = database.responses.reduce<Record<string, number>>(
    (counts, response) => {
      if (response.proofFingerprint) {
        counts[response.proofFingerprint] =
          (counts[response.proofFingerprint] ?? 0) + 1;
      }
      return counts;
    },
    {},
  );

  return {
    totalClauses: stats.clauseCount,
    mandatoryCount: database.clauses.filter(
      (clause) => clause.type === "mandatory",
    ).length,
    pendingReviews: stats.responseCount - stats.reviewedResponseCount,
    differences: stats.differenceCount,
    overdueClarifications: activeVersion
      ? versionClarifications(database, activeVersion.id).filter(
          (clarification) => clarification.status === "overdue",
        ).length
      : 0,
    reusedProofs: Object.values(proofCounts).filter((count) => count > 1)
      .length,
    activeVersion: activeVersion
      ? `${activeVersion.version} ${activeVersion.label}`
      : "未建立版本",
    activeVersionId: activeVersion?.id ?? "",
    activeVersionRevision: activeVersion?.revision ?? 0,
    opinionCount: stats.opinionCount,
    clarificationCount: stats.clarificationCount,
  };
};

const requireRole = (role: ReviewRole, allowed: ReviewRole[]): void => {
  if (!allowed.includes(role)) {
    throw new Error("当前角色无权执行此操作。");
  }
};

const requireClientToken = (token: string): void => {
  if (!token || token.trim().length < 8) {
    throw new Error("缺少有效的幂等标识，请重新载入页面后重试。");
  }
};

const findOpinionByToken = (
  database: ReviewDatabase,
  clientToken: string,
) =>
  database.responses
    .flatMap((response) => response.reviews)
    .find((review) => review.clientToken === clientToken);

const findClarificationByRequestToken = (
  database: ReviewDatabase,
  clientToken: string,
) =>
  database.responses
    .flatMap((response) => response.clarifications)
    .find((clarification) => clarification.clientToken === clientToken);

const findClarificationByResponseToken = (
  database: ReviewDatabase,
  clientToken: string,
) =>
  database.responses
    .flatMap((response) => response.clarifications)
    .find((clarification) => clarification.responseToken === clientToken);

const resolvers = {
  Query: {
    workspace: () => {
      const database = reviewDataStore.snapshot();
      return {
        ...database,
        versions: database.versions.map((version) =>
          decorateVersion(database, version),
        ),
        dashboard: getDashboard(database),
      };
    },
    dashboard: () => getDashboard(reviewDataStore.snapshot()),
  },
  Clause: {
    responses: (
      clause: Clause,
      _args: unknown,
      context: { database: ReviewDatabase; activeVersionId: string },
    ) =>
      context.database.responses
        .filter((response) => response.clauseId === clause.id)
        .map((response) => ({
          ...response,
          status: deriveResponseStatus(response, context.activeVersionId),
        })),
  },
  Mutation: {
    submitAssessment: async (
      _parent: unknown,
      { input }: { input: AssessmentInput },
    ) => {
      requireRole(input.role, ["reviewer_a", "reviewer_b", "chair"]);
      if (input.comment.trim().length < 6) {
        throw new Error("评审意见至少需要 6 个字符。");
      }
      requireClientToken(input.clientToken);
      return reviewDataStore.mutate((database) => {
        // 失败重试携带同一幂等键：直接返回已入库意见，绝不重复写入。
        const existing = findOpinionByToken(database, input.clientToken);
        if (existing) {
          return existing;
        }
        const draft = requireOpenDraft(
          database,
          input.versionId,
          input.expectedRevision,
        );
        const response = database.responses.find(
          (item) => item.id === input.responseId,
        );
        if (!response) {
          throw new Error("供应商响应不存在。");
        }
        const clause = database.clauses.find(
          (item) => item.id === response.clauseId,
        );
        if (!clause) {
          throw new Error("对应技术条款不存在。");
        }
        if (input.score < 0 || input.score > clause.weight) {
          throw new Error(`评分必须在 0 至 ${clause.weight} 之间。`);
        }
        if (
          clause.type === "scoring" &&
          input.decision === "compliant" &&
          input.score === 0
        ) {
          throw new Error("评分项判定为符合时必须填写评分。");
        }
        const opinion = {
          id: createOpinionId(),
          responseId: response.id,
          reviewer: input.reviewer.trim(),
          role: input.role,
          decision: input.decision,
          score: input.score,
          comment: input.comment.trim(),
          createdAt: new Date().toISOString(),
          versionId: draft.id,
          clientToken: input.clientToken,
        };
        response.reviews.push(opinion);
        response.reviewRound = Math.max(response.reviewRound, 1);
        draft.revision += 1;
        createAudit(
          database,
          opinion.reviewer,
          "提交独立意见",
          response.id,
          `${clause.code} ${clause.title} 判定为 ${input.decision}，评分 ${input.score}，归属 ${draft.version}。`,
          draft.id,
        );
        return opinion;
      });
    },
    requestClarification: async (
      _parent: unknown,
      { input }: { input: ClarificationInput },
    ) => {
      requireClientToken(input.clientToken);
      return reviewDataStore.mutate((database) => {
        const existing = findClarificationByRequestToken(
          database,
          input.clientToken,
        );
        if (existing) {
          return existing;
        }
        const draft = requireOpenDraft(
          database,
          input.versionId,
          input.expectedRevision,
        );
        const response = database.responses.find(
          (item) => item.id === input.responseId,
        );
        if (!response) {
          throw new Error("供应商响应不存在。");
        }
        if (input.requestText.trim().length < 6) {
          throw new Error("澄清要求至少需要 6 个字符。");
        }
        const requestedAt = new Date();
        const dueAt = new Date(input.dueAt);
        if (Number.isNaN(dueAt.getTime()) || dueAt <= requestedAt) {
          throw new Error("澄清截止时间必须晚于当前时间。");
        }
        const maximumDueAt = new Date(requestedAt);
        maximumDueAt.setDate(maximumDueAt.getDate() + 7);
        if (dueAt > maximumDueAt) {
          throw new Error("澄清期限不得超过 7 个自然日。");
        }
        const round =
          Math.max(
            0,
            ...response.clarifications
              .filter((item) => item.versionId === draft.id)
              .map((item) => item.round),
          ) + 1;
        const clarification = {
          id: createClarificationId(),
          responseId: response.id,
          clauseId: response.clauseId,
          round,
          requestText: input.requestText.trim(),
          requestedAt: requestedAt.toISOString(),
          dueAt: dueAt.toISOString(),
          status: "open" as const,
          versionId: draft.id,
          clientToken: input.clientToken,
        };
        response.clarifications.push(clarification);
        draft.revision += 1;
        createAudit(
          database,
          input.actor,
          "发起澄清",
          clarification.id,
          `${response.supplierName} ${response.clauseId} 第 ${round} 轮澄清已发起，归属 ${draft.version}。`,
          draft.id,
        );
        return clarification;
      });
    },
    respondClarification: async (
      _parent: unknown,
      { input }: { input: ClarificationResponseInput },
    ) => {
      if (input.responseText.trim().length < 6) {
        throw new Error("澄清回复至少需要 6 个字符。");
      }
      requireClientToken(input.clientToken);
      return reviewDataStore.mutate((database) => {
        const existing = findClarificationByResponseToken(
          database,
          input.clientToken,
        );
        if (existing) {
          return existing;
        }
        const draft = requireOpenDraft(
          database,
          input.versionId,
          input.expectedRevision,
        );
        const clarification = database.responses
          .flatMap((response) => response.clarifications)
          .find((item) => item.id === input.clarificationId);
        if (!clarification) {
          throw new Error("澄清记录不存在。");
        }
        if (clarification.versionId !== draft.id) {
          throw new VersionConflictError(
            "该澄清属于已定稿版本，不能补充回复，请重新载入当前工作版。",
          );
        }
        clarification.supplierResponse = input.responseText.trim();
        clarification.respondedAt = new Date().toISOString();
        clarification.status = "responded";
        clarification.responseToken = input.clientToken;
        draft.revision += 1;
        createAudit(
          database,
          input.actor,
          "回复澄清",
          clarification.id,
          `第 ${clarification.round} 轮澄清已回复，归属 ${draft.version}，等待评审员复核。`,
          draft.id,
        );
        return clarification;
      });
    },
    finalizeVersion: async (
      _parent: unknown,
      { input }: { input: FinalizeVersionInput },
    ) => {
      requireRole(input.role, ["chair"]);
      if (input.label.trim().length < 4) {
        throw new Error("版本名称至少需要 4 个字符。");
      }
      return reviewDataStore.mutate((database) => {
        const draft = requireOpenDraft(
          database,
          input.versionId,
          input.expectedRevision,
        );

        // 按服务端此刻数据检查未完成澄清，只挡住未完成澄清这一项。
        const blockingClarifications = versionClarifications(
          database,
          draft.id,
        ).filter(isClarificationBlocking);
        if (blockingClarifications.length > 0) {
          throw new Error(
            `仍有 ${blockingClarifications.length} 项未完成澄清，不能定稿。`,
          );
        }

        const now = new Date();
        const stats = computeVersionStats(database, draft.id);

        // 按服务端此刻数据锁定快照：计数与内容哈希一并冻结。
        const locked: ReviewVersion = {
          ...draft,
          ...stats,
          label: input.label.trim(),
          status: "finalized" as const,
          signedBy: [input.actor],
          contentHash: hashSnapshot(database, draft.id),
        };
        // 定稿后立刻创建新草稿承接后续意见，历史快照不再被覆盖。
        const nextDraft = createDraftVersion(database, input.actor, now);
        // 顺序：新草稿置顶，刚锁定版本次之，更旧的定稿依次在后。
        database.versions = [
          nextDraft,
          locked,
          ...database.versions.filter((version) => version.id !== draft.id),
        ];

        createAudit(
          database,
          input.actor,
          "汇总签字定稿",
          locked.id,
          `${locked.version} ${locked.label} 已按当前数据锁定：${stats.opinionCount} 条独立意见、${stats.clarificationCount} 项澄清、${stats.differenceCount} 项分歧，签署人 ${input.actor}。`,
          locked.id,
        );
        createAudit(
          database,
          input.actor,
          "创建工作版本",
          nextDraft.id,
          `${nextDraft.version} 后续评审工作版已创建，新意见归属该版本。`,
          nextDraft.id,
        );
        return locked;
      });
    },
    resetReviewData: () => {
      reviewDataStore.reset();
      return true;
    },
  },
};

const server = new ApolloServer({
  typeDefs,
  resolvers,
});

async function startServer(): Promise<void> {
  const { url } = await startStandaloneServer(server, {
    listen: { port: 18462, host: "0.0.0.0" },
    context: async () => {
      const database = reviewDataStore.snapshot();
      return {
        database,
        activeVersionId: findActiveVersion(database)?.id ?? "",
      };
    },
  });
  console.log(`GraphQL mock server ready at ${url}`);
}

void startServer();
