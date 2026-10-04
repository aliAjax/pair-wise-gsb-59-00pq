import { ChangeDetectionStrategy, Component, computed, inject } from "@angular/core";
import { DatePipe } from "@angular/common";
import { toSignal } from "@angular/core/rxjs-interop";
import { RouterLink } from "@angular/router";
import { Store } from "@ngrx/store";
import { ButtonModule } from "primeng/button";
import { ProgressBarModule } from "primeng/progressbar";
import { TableModule } from "primeng/table";
import { TagModule } from "primeng/tag";
import {
  versionedResponse,
  type Clause,
  type Clarification,
  type VersionedResponseView,
} from "../../core/models/review.models";
import {
  selectActiveVersionId,
  selectAuditLogs,
  selectClauses,
  selectDashboard,
  selectDraftVersion,
  selectError,
  selectLoading,
  selectMandatoryGaps,
  selectPendingClarifications,
  selectRole,
  selectVersions,
} from "../../core/state/review.selectors";
import {
  ClarificationTagComponent,
  StatusTagComponent,
} from "../../shared/status-tag.component";

interface PendingIssue {
  clause: Clause;
  response: VersionedResponseView;
  clarification: Clarification;
}

interface MandatoryGap {
  clause: Clause;
  response: VersionedResponseView;
}

interface DifferenceItem {
  clause: Clause;
  response: VersionedResponseView;
}

@Component({
  selector: "app-dashboard-page",
  imports: [
    RouterLink,
    DatePipe,
    ButtonModule,
    ProgressBarModule,
    TableModule,
    TagModule,
    StatusTagComponent,
    ClarificationTagComponent,
  ],
  templateUrl: "./dashboard.page.html",
  styleUrl: "./dashboard.page.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardPage {
  private readonly store = inject(Store);

  readonly dashboard = toSignal(this.store.select(selectDashboard), {
    initialValue: undefined,
  });
  readonly clauses = toSignal(this.store.select(selectClauses), {
    initialValue: [],
  });
  readonly versions = toSignal(this.store.select(selectVersions), {
    initialValue: [],
  });
  readonly draftVersion = toSignal(this.store.select(selectDraftVersion), {
    initialValue: undefined,
  });
  readonly activeVersionId = toSignal(
    this.store.select(selectActiveVersionId),
    { initialValue: "" },
  );
  readonly auditLogs = toSignal(this.store.select(selectAuditLogs), {
    initialValue: [],
  });
  readonly role = toSignal(this.store.select(selectRole), {
    initialValue: "reviewer_a",
  });
  readonly loading = toSignal(this.store.select(selectLoading), {
    initialValue: true,
  });
  readonly error = toSignal(this.store.select(selectError), {
    initialValue: undefined,
  });
  readonly pendingClarifications = toSignal(
    this.store.select(selectPendingClarifications),
    { initialValue: [] as PendingIssue[] },
  );
  /** 与服务端快照同一口径：分歧只统计当前版本归属的意见。 */
  readonly differences = computed<DifferenceItem[]>(() => {
    const versionId = this.activeVersionId();
    return this.clauses().flatMap((clause) =>
      clause.responses
        .map((response) => versionedResponse(response, versionId))
        .filter((view) => {
          const decisions = new Set(
            view.scopedReviews
              .filter((review) => review.decision !== "clarification")
              .map((review) => review.decision),
          );
          return decisions.size > 1;
        })
        .map((response) => ({ clause, response })),
    );
  });
  readonly mandatoryGaps = toSignal(
    this.store.select(selectMandatoryGaps),
    { initialValue: [] as MandatoryGap[] },
  );
  /** 当前版本覆盖进度：以“响应项”为粒度，与服务端 pendingReviews 对齐。 */
  readonly completion = computed(() => {
    const stats = this.dashboard();
    if (!stats || stats.totalClauses === 0) {
      return 0;
    }
    const totalResponses = this.clauses().reduce(
      (count, clause) => count + clause.responses.length,
      0,
    );
    if (totalResponses === 0) {
      return 0;
    }
    const reviewed = totalResponses - stats.pendingReviews;
    return Math.round((reviewed / totalResponses) * 100);
  });
}
