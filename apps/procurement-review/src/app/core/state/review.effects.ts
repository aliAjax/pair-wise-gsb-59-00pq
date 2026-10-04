import { Injectable, inject } from "@angular/core";
import { Actions, createEffect, ofType } from "@ngrx/effects";
import { from, Observable, of as observableOf } from "rxjs";
import { catchError, map, switchMap } from "rxjs/operators";
import { ReviewGraphqlService } from "../services/graphql.service";
import { ReviewActions } from "./review.actions";
import type {
  AssessmentInput,
  Clarification,
  ClarificationInput,
  ClarificationResponseInput,
  FinalizeVersionInput,
  ReviewVersion,
  ReviewerOpinion,
  WorkspaceQueryResult,
} from "../models/review.models";

/**
 * 从 Apollo 错误中提取首个 GraphQL 错误信息。
 * 服务端版本冲突、校验失败都会走这个通道。
 */
const extractGraphQLError = (error: unknown): string => {
  const graphQLErrors = (
    error as { graphQLErrors?: Array<{ message?: string }> }
  )?.graphQLErrors;
  if (Array.isArray(graphQLErrors) && graphQLErrors.length > 0) {
    return (
      graphQLErrors.map((item) => item.message).filter(Boolean)[0] ?? ""
    );
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "";
};

/** 服务端版本冲突错误统一带有“重新载入”提示。 */
const isVersionConflict = (error: unknown): boolean =>
  extractGraphQLError(error).includes("重新载入");

const errorMessage = (error: unknown): string =>
  extractGraphQLError(error) ||
  "GraphQL 请求失败，请检查本地 mock server。";

type VersionedInput =
  | AssessmentInput
  | ClarificationInput
  | ClarificationResponseInput
  | FinalizeVersionInput;

@Injectable()
export class ReviewEffects {
  private readonly actions$ = inject(Actions);
  private readonly graphql = inject(ReviewGraphqlService);

  loadReviewData$ = createEffect(() =>
    this.actions$.pipe(
      ofType(ReviewActions.loadReviewData),
      switchMap(() =>
        this.graphql.loadWorkspace().pipe(
          map(({ workspace }) =>
            ReviewActions.loadReviewDataSuccess({ workspace }),
          ),
          catchError((error: unknown) =>
            observableOf(
              ReviewActions.loadReviewDataFailure({
                error: errorMessage(error),
              }),
            ),
          ),
        ),
      ),
    ),
  );

  /**
   * 提交失败后的统一处理：
   * - 版本冲突（他人先提交或组长已定稿）：先重新载入，再按“原内容 + 同幂等键”
   *   对当前草稿重试一次；服务端按 clientToken 去重，只入库一次。
   * - 其他错误：重新载入数据并提示，不自动重试。
   */
  private recoverFromError<T extends VersionedInput>(
    error: unknown,
    input: T,
    retryRequest: (nextInput: T) => Observable<ReviewerOpinion | Clarification>,
    retryToast: string,
  ) {
    const message = errorMessage(error);
    return this.graphql.loadWorkspace().pipe(
      switchMap((result: WorkspaceQueryResult) => {
        const { workspace } = result;
        const draft = workspace.versions.find(
          (version) => version.status === "draft",
        );
        if (isVersionConflict(error) && draft) {
          const nextInput: T = this.rebased(input, draft);
          return retryRequest(nextInput).pipe(
            switchMap(() => this.graphql.loadWorkspace()),
            map((latest) =>
              ReviewActions.loadReviewDataSuccess({
                workspace: latest.workspace,
                toast: retryToast,
              }),
            ),
            catchError((retryError: unknown) =>
              observableOf(
                ReviewActions.loadReviewDataFailure({
                  error: errorMessage(retryError),
                }),
              ),
            ),
          );
        }
        // 非冲突错误：先把服务端此刻数据刷回界面，再展示失败原因。
        return from([
          ReviewActions.loadReviewDataSuccess({ workspace }),
          ReviewActions.loadReviewDataFailure({
            error: message || "提交失败，请重新载入后再试。",
          }),
        ]);
      }),
    );
  }

  submitAssessment$ = createEffect(() =>
    this.actions$.pipe(
      ofType(ReviewActions.submitAssessment),
      switchMap(({ input }) =>
        this.graphql.submitAssessment(input).pipe(
          switchMap(() => this.graphql.loadWorkspace()),
          map(({ workspace }) =>
            ReviewActions.loadReviewDataSuccess({
              workspace,
              toast: "评审意见已提交，其他评审员意见保持不变。",
            }),
          ),
          catchError((error: unknown) =>
            this.recoverFromError(
              error,
              input,
              (next) => this.graphql.submitAssessment(next),
              "版本已更新，已按原意见重新提交，且仅入库一次。",
            ),
          ),
        ),
      ),
    ),
  );

  requestClarification$ = createEffect(() =>
    this.actions$.pipe(
      ofType(ReviewActions.requestClarification),
      switchMap(({ input }) =>
        this.graphql.requestClarification(input).pipe(
          switchMap(() => this.graphql.loadWorkspace()),
          map(({ workspace }) =>
            ReviewActions.loadReviewDataSuccess({
              workspace,
              toast: "澄清要求已发出，并写入审计日志。",
            }),
          ),
          catchError((error: unknown) =>
            this.recoverFromError(
              error,
              input,
              (next) => this.graphql.requestClarification(next),
              "版本已更新，已按原澄清要求重新发起。",
            ),
          ),
        ),
      ),
    ),
  );

  respondClarification$ = createEffect(() =>
    this.actions$.pipe(
      ofType(ReviewActions.respondClarification),
      switchMap(({ input }) =>
        this.graphql.respondClarification(input).pipe(
          switchMap(() => this.graphql.loadWorkspace()),
          map(({ workspace }) =>
            ReviewActions.loadReviewDataSuccess({
              workspace,
              toast: "澄清回复已登记，等待评审员复核。",
            }),
          ),
          catchError((error: unknown) =>
            this.recoverFromError(
              error,
              input,
              (next) => this.graphql.respondClarification(next),
              "版本已更新，已按原回复内容重新登记。",
            ),
          ),
        ),
      ),
    ),
  );

  /**
   * 定稿不自动重试：冲突时必须重新载入并确认服务端此刻数据后再签字。
   */
  finalizeVersion$ = createEffect(() =>
    this.actions$.pipe(
      ofType(ReviewActions.finalizeVersion),
      switchMap(({ input }) =>
        this.graphql.finalizeVersion(input).pipe(
          switchMap(() => this.graphql.loadWorkspace()),
          map(({ workspace }) =>
            ReviewActions.loadReviewDataSuccess({
              workspace,
              toast: "评审版本已按服务端当前数据汇总签字并锁定。",
            }),
          ),
          catchError((error: unknown) =>
            this.graphql.loadWorkspace().pipe(
              switchMap(() =>
                observableOf(
                  ReviewActions.loadReviewDataFailure({
                    error:
                      errorMessage(error) ||
                      "定稿失败，请重新载入后确认数据再签字。",
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );

  resetReviewData$ = createEffect(() =>
    this.actions$.pipe(
      ofType(ReviewActions.resetReviewData),
      switchMap(() =>
        this.graphql.resetReviewData().pipe(
          switchMap(() => this.graphql.loadWorkspace()),
          map(({ workspace }) =>
            ReviewActions.loadReviewDataSuccess({
              workspace,
              toast: "评审演示数据已恢复。",
            }),
          ),
          catchError((error: unknown) =>
            observableOf(
              ReviewActions.loadReviewDataFailure({
                error: errorMessage(error),
              }),
            ),
          ),
        ),
      ),
    ),
  );

  /**
   * 冲突重试时只替换版本定位（versionId / expectedRevision），
   * 意见正文、评分和 clientToken 全部保持原值。
   */
  private rebased<T extends VersionedInput>(
    input: T,
    draft: ReviewVersion,
  ): T {
    return {
      ...input,
      versionId: draft.id,
      expectedRevision: draft.revision,
    };
  }
}
