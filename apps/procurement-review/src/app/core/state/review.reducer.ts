import { createReducer, on } from "@ngrx/store";
import type { ReviewState } from "../models/review.models";
import { ReviewActions } from "./review.actions";

export const initialReviewState: ReviewState = {
  clauses: [],
  versions: [],
  auditLogs: [],
  suppliers: [],
  filters: {
    keyword: "",
    category: "",
    type: "all",
    differencesOnly: false,
  },
  role: "reviewer_a",
  selectedSupplierIds: ["SUP-A", "SUP-B", "SUP-C"],
  revision: 0,
  loading: false,
  saving: false,
  versionConflict: false,
};

export const reviewReducer = createReducer(
  initialReviewState,
  on(ReviewActions.loadReviewData, (state) => ({
    ...state,
    loading: true,
    error: undefined,
  })),
  on(
    ReviewActions.loadReviewDataSuccess,
    (state, { workspace, toast, expectedRevision }) => {
      // 并发提交后各自触发刷新：只接受不旧于本地修订号的快照，
      // 避免后到达的旧响应覆盖新数据，保证概览/比对/导出计数一致。
      if (
        typeof expectedRevision === "number" &&
        workspace.revision < state.revision
      ) {
        return state;
      }
      return {
        ...state,
        ...workspace,
        loading: false,
        saving: false,
        error: undefined,
        versionConflict: false,
        toast,
      };
    },
  ),
  on(
    ReviewActions.loadReviewDataFailure,
    (state, { error, versionConflict }) => ({
      ...state,
      loading: false,
      saving: false,
      error,
      versionConflict: Boolean(versionConflict),
    }),
  ),
  on(ReviewActions.setRole, (state, { role }) => ({
    ...state,
    role,
    toast: undefined,
  })),
  on(ReviewActions.setFilters, (state, { filters }) => ({
    ...state,
    filters: {
      ...state.filters,
      ...filters,
    },
  })),
  on(ReviewActions.toggleSupplier, (state, { supplierId }) => {
    const selected = state.selectedSupplierIds.includes(supplierId);
    const next = selected
      ? state.selectedSupplierIds.filter((id) => id !== supplierId)
      : [...state.selectedSupplierIds, supplierId];
    return {
      ...state,
      selectedSupplierIds: next.length > 0 ? next : state.selectedSupplierIds,
    };
  }),
  on(ReviewActions.clearToast, (state) => ({
    ...state,
    toast: undefined,
    error: undefined,
    versionConflict: false,
  })),
  on(
    ReviewActions.submitAssessment,
    ReviewActions.requestClarification,
    ReviewActions.respondClarification,
    ReviewActions.finalizeVersion,
    ReviewActions.resetReviewData,
    (state) => ({
      ...state,
      saving: true,
      error: undefined,
      versionConflict: false,
      toast: undefined,
    }),
  ),
);
