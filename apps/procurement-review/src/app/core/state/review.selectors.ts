import { createFeatureSelector, createSelector } from "@ngrx/store";
import type {
  Clause,
  ClauseTreeNode,
  ReviewState,
  ReviewVersion,
  SupplierResponse,
  VersionedResponseView,
} from "../models/review.models";
import { versionedResponse } from "../models/review.models";

export const selectReviewState =
  createFeatureSelector<ReviewState>("review");

export const selectClauses = createSelector(
  selectReviewState,
  (state) => state.clauses,
);

export const selectVersions = createSelector(
  selectReviewState,
  (state) => state.versions,
);

/** 当前工作草稿：所有新提交、澄清和统计都以它为准。 */
export const selectDraftVersion = createSelector(
  selectVersions,
  (versions): ReviewVersion | undefined =>
    versions.find((version) => version.status === "draft"),
);

/**
 * 当前活动版本 ID：优先草稿，定稿后自动指向新草稿。
 * 所有意见、澄清和计数的归属口径都来自这里。
 */
export const selectActiveVersionId = createSelector(
  selectDraftVersion,
  selectVersions,
  (draft, versions): string =>
    draft?.id ?? versions.find((version) => version.status === "finalized")?.id ?? "",
);

export const selectAuditLogs = createSelector(
  selectReviewState,
  (state) => state.auditLogs,
);

export const selectDashboard = createSelector(
  selectReviewState,
  (state) => state.dashboard,
);

export const selectSuppliers = createSelector(
  selectReviewState,
  (state) => state.suppliers,
);

export const selectFilters = createSelector(
  selectReviewState,
  (state) => state.filters,
);

export const selectRole = createSelector(
  selectReviewState,
  (state) => state.role,
);

export const selectSelectedSupplierIds = createSelector(
  selectReviewState,
  (state) => state.selectedSupplierIds,
);

export const selectLoading = createSelector(
  selectReviewState,
  (state) => state.loading,
);

export const selectSaving = createSelector(
  selectReviewState,
  (state) => state.saving,
);

export const selectError = createSelector(
  selectReviewState,
  (state) => state.error,
);

export const selectToast = createSelector(
  selectReviewState,
  (state) => state.toast,
);

export const hasReviewDifference = (
  response: SupplierResponse,
  versionId?: string,
): boolean => {
  const reviews = versionId
    ? response.reviews.filter((review) => review.versionId === versionId)
    : response.reviews;
  const decisions = new Set(
    reviews
      .filter((review) => review.decision !== "clarification")
      .map((review) => review.decision),
  );
  return decisions.size > 1;
};

export const findResponse = (
  clause: Clause,
  supplierId: string,
): SupplierResponse | undefined =>
  clause.responses.find((response) => response.supplierId === supplierId);

/** 按当前版本生成响应视图，概览、比对、复核共用同一口径。 */
export const scopedResponses = (
  responses: SupplierResponse[],
  versionId: string,
): VersionedResponseView[] =>
  responses.map((response) => versionedResponse(response, versionId));

const filteredClauses = createSelector(
  selectClauses,
  selectFilters,
  selectActiveVersionId,
  (clauses, filters, activeVersionId) => {
    const keyword = filters.keyword.trim().toLowerCase();
    return clauses.filter((clause) => {
      const matchesKeyword =
        !keyword ||
        [
          clause.code,
          clause.title,
          clause.category,
          clause.requirement,
          ...clause.responses.map((response) => response.supplierName),
        ]
          .join(" ")
          .toLowerCase()
          .includes(keyword);
      const matchesCategory =
        !filters.category || clause.category === filters.category;
      const matchesType =
        filters.type === "all" || clause.type === filters.type;
      const matchesDifference =
        !filters.differencesOnly ||
        clause.responses.some((response) =>
          hasReviewDifference(response, activeVersionId),
        );
      return (
        matchesKeyword &&
        matchesCategory &&
        matchesType &&
        matchesDifference
      );
    });
  },
);

export const selectFilteredClauses = filteredClauses;

export const selectClauseTree = createSelector(
  selectClauses,
  filteredClauses,
  (allClauses, matchingClauses): ClauseTreeNode[] => {
    if (matchingClauses.length === 0) {
      return [];
    }
    const includedIds = new Set<string>();
    const byId = new Map(allClauses.map((clause) => [clause.id, clause]));
    matchingClauses.forEach((clause) => {
      includedIds.add(clause.id);
      let parentId = clause.parentId;
      while (parentId && !includedIds.has(parentId)) {
        includedIds.add(parentId);
        parentId = byId.get(parentId)?.parentId;
      }
    });
    const selected = allClauses
      .filter((clause) => includedIds.has(clause.id))
      .sort((a, b) => a.order - b.order);
    const nodeMap = new Map<string, ClauseTreeNode>();
    selected.forEach((clause) => {
      nodeMap.set(clause.id, { ...clause, children: [] });
    });
    const roots: ClauseTreeNode[] = [];
    selected.forEach((clause) => {
      const node = nodeMap.get(clause.id);
      if (!node) {
        return;
      }
      if (clause.parentId && nodeMap.has(clause.parentId)) {
        nodeMap.get(clause.parentId)?.children.push(node);
      } else {
        roots.push(node);
      }
    });
    return roots;
  },
);

export const selectDifferences = createSelector(
  selectClauses,
  selectActiveVersionId,
  (clauses, activeVersionId) =>
    clauses.flatMap((clause) =>
      clause.responses
        .filter((response) => hasReviewDifference(response, activeVersionId))
        .map((response) => ({
          clause,
          response: versionedResponse(response, activeVersionId),
        })),
    ),
);

export const selectPendingClarifications = createSelector(
  selectClauses,
  selectActiveVersionId,
  (clauses, activeVersionId) =>
    clauses.flatMap((clause) =>
      clause.responses.flatMap((response) =>
        versionedResponse(response, activeVersionId)
          .scopedClarifications.filter(
            (clarification) =>
              clarification.status === "open" ||
              clarification.status === "overdue",
          )
          .map((clarification) => ({
            clause,
            response: versionedResponse(response, activeVersionId),
            clarification,
          })),
      ),
    ),
);

/** 当前版本下存在否决项结论缺口（无意见或仍有进行中澄清）的响应。 */
export const selectMandatoryGaps = createSelector(
  selectClauses,
  selectActiveVersionId,
  (clauses, activeVersionId) =>
    clauses
      .filter((clause) => clause.type === "mandatory")
      .flatMap((clause) =>
        clause.responses
          .map((response) => versionedResponse(response, activeVersionId))
          .filter(
            (view) =>
              view.derivedStatus === "pending" ||
              view.derivedStatus === "clarification",
          )
          .map((response) => ({ clause, response })),
      ),
);

export const selectReusedProofs = createSelector(
  selectClauses,
  (clauses) => {
    const counts = new Map<
      string,
      Array<{ clause: Clause; response: SupplierResponse }>
    >();
    clauses.forEach((clause) => {
      clause.responses.forEach((response) => {
        const current = counts.get(response.proofFingerprint) ?? [];
        current.push({ clause, response });
        counts.set(response.proofFingerprint, current);
      });
    });
    return Array.from(counts.entries())
      .filter(([, entries]) => entries.length > 1)
      .map(([fingerprint, entries]) => ({ fingerprint, entries }));
  },
);

export const responseDecisionSummary = (
  response: SupplierResponse,
  versionId?: string,
): string[] =>
  Array.from(
    new Set(
      (versionId
        ? response.reviews.filter((review) => review.versionId === versionId)
        : response.reviews
      ).map((review) => review.decision),
    ),
  );
