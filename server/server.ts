import { ApolloServer } from "@apollo/server";
import { startStandaloneServer } from "@apollo/server/standalone";
import { createHash } from "node:crypto";
import {
  createAudit,
  createClarificationId,
  createOpinionId,
  createVersionId,
  reviewDataStore,
  ReviewVersionConflictError,
} from "./data";
import { typeDefs } from "./schema";
import type {
  AssessmentInput,
  Clarification,
  ClarificationInput,
  ClarificationResponseInput,
  Clause,
  DashboardStats,
  FinalizeVersionInput,
  ReviewDatabase,
  ReviewRole,
  ReviewVersion,
  ReviewerOpinion,
  SupplierResponse,
  VersionSnapshot,
} from "./types";

const currentDraftId = (database: ReviewDatabase): string | undefined =>
  database.versions.find((version) => version.status === "draft")?.id;

const isOverdue = (clarification: Clarification, now: Date = new Date()): boolean =>
  clarification.status === "overdue" ||
  (clarification.status === "open" &&
    Date.parse(clarification.dueAt) <= now.getTime());

/** 只统计归属当前草稿版本的意见与澄清，概览/比对/导出共用同一口径。 */
const draftScopedResponses = (database: ReviewDatabase): SupplierResponse[] => {
  const draftId = currentDraftId(database);
  return database.responses.map((response) => ({
    ...response,
    reviews: response.reviews.filter((review) => review.versionId === draftId),
    clarifications: response.clarifications.filter(
      (clarification) => clarification.versionId === draftId,
    ),
  }));
};

const computeSnapshot = (
  database: ReviewDatabase,
  draft: ReviewVersion,
): VersionSnapshot => {
  const scoped = draftScopedResponses(database);
  const opinions = scoped.flatMap((response) =>
    response.reviews.map((review) => [
      review.responseId,
      review.reviewer,
      review.role,
      review.decision,
      String(review.score),
      review.comment,
      review.createdAt,
    ]),
  );
  const clarifications = scoped.flatMap((response) =>
    response.clarifications.map((clarification) => [
      clarification.responseId,
      String(clarification.round),
      clarification.requestText,
      clarification.supplierResponse ?? "",
      clarification.status,
    ]),
  );
  const contentHash = createHash("sha256")
    .update(
      JSON.stringify({
        version: draft.id,
        opinionCount: opinions.length,
        clarificationCount: clarifications.length,
        opinions: opinions.sort(),
        clarifications: clarifications.sort(),
      }),
    )
    .digest("hex")
    .slice(0, 8);
  return {
    contentHash,
    opinionCount: opinions.length,
    clarificationCount: clarifications.length,
    responses: scoped.map((response) => ({
      responseId: response.id,
      opinionCount: response.reviews.length,
      clarificationCount: response.clarifications.length,
    })),
  };
};

const getDashboard = (database: ReviewDatabase): DashboardStats => {
  const scopedResponses = draftScopedResponses(database);
  const opinionsByResponse = scopedResponses.map((response) => {
    const decisions = new Set(
      response.reviews
        .filter((review) => review.decision !== "clarification")
        .map((review) => review.decision),
    );
    return decisions.size > 1;
  });
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
  const draft = database.versions.find((version) => version.status === "draft");

  return {
    totalClauses: database.clauses.length,
    mandatoryCount: database.clauses.filter(
      (clause) => clause.type === "mandatory",
    ).length,
    pendingReviews: scopedResponses.filter(
      (response) => response.reviews.length < 2,
    ).length,
    opinionCount: scopedResponses.reduce(
      (count, response) => count + response.reviews.length,
      0,
    ),
    differences: opinionsByResponse.filter(Boolean).length,
    overdueClarifications: scopedResponses.reduce(
      (count, response) =>
        count + response.clarifications.filter((item) => isOverdue(item)).length,
      0,
    ),
    reusedProofs: Object.values(proofCounts).filter((count) => count > 1)
      .length,
    activeVersion: draft
      ? `${draft.version} ${draft.label}`
      : "全部版本已定稿，请等待新草稿",
  };
};

const requireRole = (role: ReviewRole, allowed: ReviewRole[]): void => {
  if (!allowed.includes(role)) {
    throw new Error("当前角色无权执行此操作。");
  }
};

const requireDraft = (
  database: ReviewDatabase,
  baseVersionId: string,
): ReviewVersion => {
  const draft = database.versions.find((version) => version.status === "draft");
  if (!draft || draft.id !== baseVersionId) {
    throw new ReviewVersionConflictError(
      "您编辑的评审版本已被定稿或更新，请重新载入最新评审版本后再提交。",
    );
  }
  return draft;
};

const findOpinion = (database: ReviewDatabase, mutationId: string) =>
  database.responses
    .flatMap((response) => response.reviews)
    .find((opinion) => opinion.clientMutationId === mutationId);

const findClarification = (database: ReviewDatabase, mutationId: string) =>
  database.responses
    .flatMap((response) => response.clarifications)
    .find((clarification) => clarification.clientMutationId === mutationId);

const resolvers = {
  Query: {
    workspace: () => {
      const database = reviewDataStore.snapshot();
      return {
        ...database,
        dashboard: getDashboard(database),
      };
    },
    dashboard: () => getDashboard(reviewDataStore.snapshot()),
  },
  Clause: {
    responses: (
      clause: Clause,
      _args: unknown,
      context: { database: ReviewDatabase },
    ) =>
      context.database.responses.filter(
        (response) => response.clauseId === clause.id,
      ),
  },
  SupplierResponse: {
    // 活数据只暴露当前草稿版本的意见和澄清；已定稿版本的记录通过版本快照读取。
    reviews: (
      response: SupplierResponse,
      _args: unknown,
      context: { database: ReviewDatabase },
    ) => {
      const draftId = currentDraftId(context.database);
      return response.reviews.filter((review) => review.versionId === draftId);
    },
    clarifications: (
      response: SupplierResponse,
      _args: unknown,
      context: { database: ReviewDatabase },
    ) => {
      const draftId = currentDraftId(context.database);
      return response.clarifications.filter(
        (clarification) => clarification.versionId === draftId,
      );
    },
  },
  Mutation: {
    submitAssessment: (
      _parent: unknown,
      { input }: { input: AssessmentInput },
    ) =>
      reviewDataStore.mutate(
        input.clientMutationId,
        (database) => {
          requireRole(input.role, ["reviewer_a", "reviewer_b", "chair"]);
          if (input.comment.trim().length < 6) {
            throw new Error("评审意见至少需要 6 个字符。");
          }
          const draft = requireDraft(database, input.baseVersionId);
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
          const duplicate = response.reviews.find(
            (review) =>
              review.versionId === draft.id &&
              review.reviewer === input.reviewer.trim() &&
              review.role === input.role,
          );
          if (duplicate) {
            throw new ReviewVersionConflictError(
              "您在当前版本已提交该响应的独立意见，请重新载入后查看最新评审数据。",
            );
          }
          const opinion: ReviewerOpinion = {
            id: createOpinionId(),
            responseId: response.id,
            versionId: draft.id,
            reviewer: input.reviewer.trim(),
            role: input.role,
            decision: input.decision,
            score: input.score,
            comment: input.comment.trim(),
            createdAt: new Date().toISOString(),
            clientMutationId: input.clientMutationId,
          };
          response.reviews.push(opinion);
          response.status = input.decision;
          response.reviewRound = Math.max(response.reviewRound, 1);
          createAudit(
            database,
            opinion.reviewer,
            "提交独立意见",
            response.id,
            `${draft.version} ${clause.code} ${clause.title} 判定为 ${input.decision}，评分 ${input.score}。`,
          );
          return opinion;
        },
        (database) => {
          const replay = findOpinion(database, input.clientMutationId);
          if (!replay) {
            throw new Error("未找到首次提交的评审意见记录。");
          }
          return replay;
        },
      ).then(({ result }) => result),
    requestClarification: (
      _parent: unknown,
      { input }: { input: ClarificationInput },
    ) =>
      reviewDataStore.mutate(
        input.clientMutationId,
        (database) => {
          const draft = requireDraft(database, input.baseVersionId);
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
              ...response.clarifications.map((item) => item.round),
            ) + 1;
          const clarification: Clarification = {
            id: createClarificationId(),
            responseId: response.id,
            clauseId: response.clauseId,
            versionId: draft.id,
            round,
            requestText: input.requestText.trim(),
            requestedAt: requestedAt.toISOString(),
            dueAt: dueAt.toISOString(),
            status: "open",
            clientMutationId: input.clientMutationId,
          };
          response.clarifications.push(clarification);
          response.status = "clarification";
          createAudit(
            database,
            input.actor,
            "发起澄清",
            clarification.id,
            `${draft.version} ${response.supplierName} ${response.clauseId} 第 ${round} 轮澄清已发起。`,
          );
          return clarification;
        },
        (database) => {
          const replay = findClarification(database, input.clientMutationId);
          if (!replay) {
            throw new Error("未找到首次发起的澄清记录。");
          }
          return replay;
        },
      ).then(({ result }) => result),
    respondClarification: (
      _parent: unknown,
      { input }: { input: ClarificationResponseInput },
    ) =>
      reviewDataStore.mutate(
        input.clientMutationId,
        (database) => {
          const draft = requireDraft(database, input.baseVersionId);
          const clarification = database.responses
            .flatMap((response) => response.clarifications)
            .find((item) => item.id === input.clarificationId);
          if (!clarification) {
            throw new Error("澄清记录不存在。");
          }
          if (clarification.versionId !== draft.id) {
            throw new ReviewVersionConflictError(
              "该澄清归属已定稿版本，不能补回复，请重新载入后在当前草稿中处理。",
            );
          }
          if (clarification.status === "responded") {
            throw new ReviewVersionConflictError(
              "该澄清已有回复，请重新载入后查看最新状态。",
            );
          }
          if (input.responseText.trim().length < 6) {
            throw new Error("澄清回复至少需要 6 个字符。");
          }
          clarification.supplierResponse = input.responseText.trim();
          clarification.respondedAt = new Date().toISOString();
          clarification.status = "responded";
          const response = database.responses.find(
            (item) => item.id === clarification.responseId,
          );
          if (response) {
            response.status = "pending";
          }
          createAudit(
            database,
            input.actor,
            "回复澄清",
            clarification.id,
            `${draft.version} 第 ${clarification.round} 轮澄清已回复，等待评审员复核。`,
          );
          return clarification;
        },
        (database) => {
          const replay = database.responses
            .flatMap((response) => response.clarifications)
            .find((item) => item.id === input.clarificationId);
          if (!replay) {
            throw new Error("澄清记录不存在。");
          }
          return replay;
        },
      ).then(({ result }) => result),
    finalizeVersion: (
      _parent: unknown,
      { input }: { input: FinalizeVersionInput },
    ) =>
      reviewDataStore.mutate(
        input.clientMutationId,
        (database) => {
          requireRole(input.role, ["chair"]);
          if (input.label.trim().length < 4) {
            throw new Error("版本名称至少需要 4 个字符。");
          }
          const draft = requireDraft(database, input.baseVersionId);
          const blockingClarifications = database.responses
            .flatMap((response) => response.clarifications)
            .filter(
              (clarification) =>
                clarification.versionId === draft.id &&
                (clarification.status === "open" ||
                  clarification.status === "overdue" ||
                  isOverdue(clarification)),
            );
          if (blockingClarifications.length > 0) {
            throw new Error(
              `仍有 ${blockingClarifications.length} 项未完成澄清，不能定稿。`,
            );
          }
          // 串行队列保证此处读到的就是服务端此刻数据，快照一次性锁定。
          const snapshot = computeSnapshot(database, draft);
          const lockedAt = new Date().toISOString();
          draft.status = "finalized";
          draft.signedBy = [input.actor];
          draft.contentHash = snapshot.contentHash;
          draft.snapshot = snapshot;
          draft.lockMutationId = input.clientMutationId;
          createAudit(
            database,
            input.actor,
            "汇总签字定稿",
            draft.id,
            `${draft.version} ${draft.label} 已锁定，独立意见 ${snapshot.opinionCount} 条、澄清 ${snapshot.clarificationCount} 项，签署人 ${input.actor}。`,
          );

          // 自动创建下一版草稿；历史意见保留在已定稿版本下，不再污染活数据。
          const maxNumber = database.versions.reduce((maximum, version) => {
            const numeric = Number(version.version.replace(/\D/g, ""));
            return Number.isFinite(numeric)
              ? Math.max(maximum, numeric)
              : maximum;
          }, 0);
          const nextDraft: ReviewVersion = {
            id: createVersionId(),
            version: `V${maxNumber + 1}`,
            label: `第 ${maxNumber + 1} 轮评审工作版`,
            status: "draft",
            createdAt: lockedAt,
            createdBy: input.actor,
            signedBy: [],
            clauseCount: database.clauses.length,
            responseCount: database.responses.length,
            contentHash: "",
            snapshot: null,
          };
          // 新一轮评审：响应回到待评审基线，历史意见/澄清仍带旧版本 ID 保留。
          database.responses.forEach((response) => {
            const clause = database.clauses.find(
              (item) => item.id === response.clauseId,
            );
            response.status =
              clause?.type === "mandatory" ? "compliant" : "pending";
            response.reviewRound = 1;
          });
          database.versions.unshift(nextDraft);
          createAudit(
            database,
            input.actor,
            "创建工作版本",
            nextDraft.id,
            `${nextDraft.version} ${nextDraft.label} 已在定稿后自动创建。`,
          );
          return draft;
        },
        (database) => {
          const replay = database.versions.find(
            (version) => version.lockMutationId === input.clientMutationId,
          );
          if (!replay) {
            throw new Error("未找到首次定稿的版本记录。");
          }
          return replay;
        },
      ).then(({ result }) => result),
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
    context: async () => ({
      database: reviewDataStore.snapshot(),
    }),
  });
  console.log(`GraphQL mock server ready at ${url}`);
}

void startServer();
