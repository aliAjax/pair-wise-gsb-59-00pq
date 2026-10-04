import type {
  Clause,
  ReviewVersion,
  SupplierResponse,
  VersionSnapshot,
} from "../models/review.models";

interface GraphErrorShape {
  message: string;
  extensions?: Record<string, unknown>;
}
interface ApolloErrorShape {
  graphQLErrors?: ReadonlyArray<GraphErrorShape>;
  message?: string;
  networkError?: Error | null;
}

/** 生成单次逻辑提交的幂等键；同一次提交的网络重试必须复用同一个键。 */
export const createClientMutationId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const VERSION_CONFLICT_CODE = "REVIEW_VERSION_CONFLICT";

export const isVersionConflictError = (error: unknown): boolean => {
  const apolloError = error as ApolloErrorShape | null | undefined;
  if (
    apolloError?.graphQLErrors?.some(
      (item) => item.extensions?.["code"] === VERSION_CONFLICT_CODE,
    )
  ) {
    return true;
  }
  return typeof apolloError?.message === "string"
    && apolloError.message.includes("重新载入");
};

export const errorMessage = (error: unknown): string => {
  const apolloError = error as ApolloErrorShape | null | undefined;
  const first = apolloError?.graphQLErrors?.[0]?.message;
  if (first) {
    return first;
  }
  if (typeof apolloError?.message === "string" && apolloError.message) {
    return apolloError.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "GraphQL 请求失败，请检查本地 mock server。";
};

export const selectDraftVersion = (
  versions: readonly ReviewVersion[],
): ReviewVersion | undefined => versions.find((version) => version.status === "draft");

/** 当前草稿下的独立意见总数；概览、比对、导出共用同一口径。 */
export const countDraftOpinions = (clauses: readonly Clause[]): number =>
  clauses.reduce(
    (total, clause) =>
      total +
      clause.responses.reduce(
        (count: number, response: SupplierResponse) =>
          count + response.reviews.length,
        0,
      ),
    0,
  );

/** 当前草稿下归属当前版本的澄清总数（含已回复）。 */
export const countDraftClarifications = (clauses: readonly Clause[]): number =>
  clauses.reduce(
    (total, clause) =>
      total +
      clause.responses.reduce(
        (count, response) => count + response.clarifications.length,
        0,
      ),
    0,
  );

/**
 * 版本历史/比对/导出读取的计数：已定稿版本读锁定快照，
 * 没有快照的旧定稿数据按 0 处理，绝不与活数据混算。
 */
export const snapshotCounts = (
  version: ReviewVersion,
): Pick<VersionSnapshot, "opinionCount" | "clarificationCount"> => ({
  opinionCount: version.snapshot?.opinionCount ?? 0,
  clarificationCount: version.snapshot?.clarificationCount ?? 0,
});
