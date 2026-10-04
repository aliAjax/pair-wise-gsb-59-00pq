import { Injectable, inject } from "@angular/core";
import { Actions, createEffect, ofType } from "@ngrx/effects";
import type { Action } from "@ngrx/store";
import { Observable, of } from "rxjs";
import { catchError, map, switchMap } from "rxjs/operators";
import { ReviewGraphqlService } from "../services/graphql.service";
import { ReviewActions } from "./review.actions";
import { errorMessage, isVersionConflictError } from "./review.utils";

@Injectable()
export class ReviewEffects {
  private readonly actions$ = inject(Actions);
  private readonly graphql = inject(ReviewGraphqlService);

  /**
   * mutation 成功后以服务端最新数据重新载入；提交本身带 baseVersionId 与
   * clientMutationId，旧版本提交会在服务端被拒绝（版本冲突），传输失败
   * 则由 GraphQL 层用同一幂等键重试，保证同一条意见只入库一次。
   */
  private runMutation<T>(
    mutation$: Observable<T>,
    toast: string,
  ): Observable<Action> {
    return mutation$.pipe(
      switchMap(() => this.graphql.loadWorkspace()),
      map(({ workspace }) =>
        ReviewActions.loadReviewDataSuccess({
          workspace,
          toast,
          expectedRevision: workspace.revision,
        }),
      ),
      catchError((error: unknown) =>
        isVersionConflictError(error)
          ? of(
              ReviewActions.loadReviewDataFailure({
                error: `${errorMessage(error)}（本地内容未覆盖，已保留您原意见）`,
                versionConflict: true,
              }),
              ReviewActions.loadReviewData({ force: true }),
            )
          : of(
              ReviewActions.loadReviewDataFailure({
                error: errorMessage(error),
              }),
            ),
      ),
    );
  }

  loadReviewData$ = createEffect(() =>
    this.actions$.pipe(
      ofType(ReviewActions.loadReviewData),
      switchMap(() =>
        this.graphql.loadWorkspace().pipe(
          map(({ workspace }) =>
            ReviewActions.loadReviewDataSuccess({ workspace }),
          ),
          catchError((error: unknown) =>
            of(
              ReviewActions.loadReviewDataFailure({
                error: errorMessage(error),
              }),
            ),
          ),
        ),
      ),
    ),
  );

  submitAssessment$ = createEffect(() =>
    this.actions$.pipe(
      ofType(ReviewActions.submitAssessment),
      switchMap(({ input }) =>
        this.runMutation(
          this.graphql.submitAssessment(input),
          "评审意见已提交，其他评审员意见保持不变。",
        ),
      ),
    ),
  );

  requestClarification$ = createEffect(() =>
    this.actions$.pipe(
      ofType(ReviewActions.requestClarification),
      switchMap(({ input }) =>
        this.runMutation(
          this.graphql.requestClarification(input),
          "澄清要求已发出，并写入审计日志。",
        ),
      ),
    ),
  );

  respondClarification$ = createEffect(() =>
    this.actions$.pipe(
      ofType(ReviewActions.respondClarification),
      switchMap(({ input }) =>
        this.runMutation(
          this.graphql.respondClarification(input),
          "澄清回复已登记，等待评审员复核。",
        ),
      ),
    ),
  );

  finalizeVersion$ = createEffect(() =>
    this.actions$.pipe(
      ofType(ReviewActions.finalizeVersion),
      switchMap(({ input }) =>
        this.runMutation(
          this.graphql.finalizeVersion(input),
          "评审版本已按服务端此刻数据锁定快照并完成签字。",
        ),
      ),
    ),
  );

  resetReviewData$ = createEffect(() =>
    this.actions$.pipe(
      ofType(ReviewActions.resetReviewData),
      switchMap(() =>
        this.graphql.resetReviewData().pipe(
          map(() => ReviewActions.loadReviewData({ force: true })),
          catchError((error: unknown) =>
            of(
              ReviewActions.loadReviewDataFailure({
                error: errorMessage(error),
              }),
            ),
          ),
        ),
      ),
    ),
  );
}
