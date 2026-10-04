import { Injectable, inject } from "@angular/core";
import { Apollo, gql } from "apollo-angular";
import { Observable, defer, of, retryWhen, throwError } from "rxjs";
import { map, mergeMap, take } from "rxjs/operators";
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
import { isVersionConflictError } from "../state/review.utils";

const WORKSPACE_QUERY = gql`
  query ProcurementReviewWorkspace {
    workspace {
      clauses {
        id
        code
        title
        category
        requirement
        type
        weight
        parentId
        evidenceRequired
        order
        responses {
          id
          clauseId
          supplierId
          supplierName
          status
          responseText
          claimedScore
          attachmentName
          proofFingerprint
          submittedBy
          submittedAt
          reviewRound
          reviews {
            id
            responseId
            versionId
            reviewer
            role
            decision
            score
            comment
            createdAt
          }
          clarifications {
            id
            responseId
            clauseId
            versionId
            round
            requestText
            supplierResponse
            requestedAt
            dueAt
            respondedAt
            status
          }
        }
      }
      versions {
        id
        version
        label
        status
        createdAt
        createdBy
        signedBy
        clauseCount
        responseCount
        contentHash
        snapshot {
          contentHash
          opinionCount
          clarificationCount
          responses {
            responseId
            opinionCount
            clarificationCount
          }
        }
      }
      auditLogs {
        id
        at
        actor
        action
        entity
        detail
      }
      dashboard {
        totalClauses
        mandatoryCount
        pendingReviews
        opinionCount
        differences
        overdueClarifications
        reusedProofs
        activeVersion
      }
      suppliers {
        id
        name
      }
      revision
    }
  }
`;

const SUBMIT_ASSESSMENT = gql`
  mutation SubmitAssessment($input: AssessmentInput!) {
    submitAssessment(input: $input) {
      id
      responseId
      versionId
      reviewer
      role
      decision
      score
      comment
      createdAt
    }
  }
`;

const REQUEST_CLARIFICATION = gql`
  mutation RequestClarification($input: ClarificationInput!) {
    requestClarification(input: $input) {
      id
      responseId
      clauseId
      versionId
      round
      requestText
      supplierResponse
      requestedAt
      dueAt
      respondedAt
      status
    }
  }
`;

const RESPOND_CLARIFICATION = gql`
  mutation RespondClarification($input: ClarificationResponseInput!) {
    respondClarification(input: $input) {
      id
      responseId
      clauseId
      versionId
      round
      requestText
      supplierResponse
      requestedAt
      dueAt
      respondedAt
      status
    }
  }
`;

const FINALIZE_VERSION = gql`
  mutation FinalizeVersion($input: FinalizeVersionInput!) {
    finalizeVersion(input: $input) {
      id
      version
      label
      status
      createdAt
      createdBy
      signedBy
      clauseCount
      responseCount
      contentHash
      snapshot {
        contentHash
        opinionCount
        clarificationCount
      }
    }
  }
`;

const RESET_REVIEW_DATA = gql`
  mutation ResetReviewData {
    resetReviewData
  }
`;

/**
 * 只有网络/传输类失败才用同一 clientMutationId 重试一次；
 * 业务校验失败和版本冲突绝不重试。服务端按幂等键去重，保证只入库一次。
 */
const retryTransportOnce = <T>(source: Observable<T>): Observable<T> =>
  defer(() => {
    let attempts = 0;
    return source.pipe(
      retryWhen((errors) =>
        errors.pipe(
          mergeMap((error: unknown) => {
            attempts += 1;
            const networkOnly =
              !isVersionConflictError(error) &&
              !(
                error as { graphQLErrors?: unknown[] } | null
              )?.graphQLErrors?.length;
            if (attempts === 1 && networkOnly) {
              return of(null);
            }
            return throwError(() => error);
          }),
          take(2),
        ),
      ),
    );
  });

@Injectable({ providedIn: "root" })
export class ReviewGraphqlService {
  private readonly apollo = inject(Apollo);

  loadWorkspace(): Observable<WorkspaceQueryResult> {
    return this.apollo
      .query<WorkspaceQueryResult>({
        query: WORKSPACE_QUERY,
        fetchPolicy: "network-only",
      })
      .pipe(
        map((result) => {
          if (!result.data) {
            throw new Error("GraphQL 未返回评审工作区。");
          }
          return result.data as WorkspaceQueryResult;
        }),
      );
  }

  submitAssessment(input: AssessmentInput): Observable<ReviewerOpinion> {
    return retryTransportOnce(
      this.apollo
        .mutate<{ submitAssessment: ReviewerOpinion }>({
          mutation: SUBMIT_ASSESSMENT,
          variables: { input },
        })
        .pipe(
          map((result) => {
            if (!result.data) {
              throw new Error("GraphQL 未返回评审意见。");
            }
            return result.data.submitAssessment;
          }),
        ),
    );
  }

  requestClarification(input: ClarificationInput): Observable<Clarification> {
    return retryTransportOnce(
      this.apollo
        .mutate<{ requestClarification: Clarification }>({
          mutation: REQUEST_CLARIFICATION,
          variables: { input },
        })
        .pipe(
          map((result) => {
            if (!result.data) {
              throw new Error("GraphQL 未返回澄清记录。");
            }
            return result.data.requestClarification;
          }),
        ),
    );
  }

  respondClarification(
    input: ClarificationResponseInput,
  ): Observable<Clarification> {
    return retryTransportOnce(
      this.apollo
        .mutate<{ respondClarification: Clarification }>({
          mutation: RESPOND_CLARIFICATION,
          variables: { input },
        })
        .pipe(
          map((result) => {
            if (!result.data) {
              throw new Error("GraphQL 未返回澄清回复。");
            }
            return result.data.respondClarification;
          }),
        ),
    );
  }

  finalizeVersion(input: FinalizeVersionInput): Observable<ReviewVersion> {
    return retryTransportOnce(
      this.apollo
        .mutate<{ finalizeVersion: ReviewVersion }>({
          mutation: FINALIZE_VERSION,
          variables: { input },
        })
        .pipe(
          map((result) => {
            if (!result.data) {
              throw new Error("GraphQL 未返回版本信息。");
            }
            return result.data.finalizeVersion;
          }),
        ),
    );
  }

  resetReviewData(): Observable<boolean> {
    return this.apollo
      .mutate<{ resetReviewData: boolean }>({
        mutation: RESET_REVIEW_DATA,
      })
      .pipe(
        map((result) => {
          if (!result.data) {
            throw new Error("GraphQL 未返回重置结果。");
          }
          return result.data.resetReviewData;
        }),
      );
  }
}
