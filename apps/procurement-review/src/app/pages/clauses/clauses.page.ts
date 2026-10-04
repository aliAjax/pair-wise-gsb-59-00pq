import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from "@angular/core";
import { DatePipe } from "@angular/common";
import {
  FormControl,
  FormGroup,
  FormsModule,
  ReactiveFormsModule,
  Validators,
} from "@angular/forms";
import { toSignal } from "@angular/core/rxjs-interop";
import { RouterLink } from "@angular/router";
import { Store } from "@ngrx/store";
import type { TreeNode } from "primeng/api";
import { AccordionModule } from "primeng/accordion";
import { ButtonModule } from "primeng/button";
import { DatePickerModule } from "primeng/datepicker";
import { DialogModule } from "primeng/dialog";
import { InputNumberModule } from "primeng/inputnumber";
import { InputTextModule } from "primeng/inputtext";
import { SelectModule } from "primeng/select";
import { TagModule } from "primeng/tag";
import { TextareaModule } from "primeng/textarea";
import { TreeModule } from "primeng/tree";
import {
  complianceLabels,
  createClientToken,
  roleProfiles,
  versionedResponse,
  type Clause,
  type ComplianceStatus,
  type SupplierResponse,
  type VersionedResponseView,
} from "../../core/models/review.models";
import { ReviewActions } from "../../core/state/review.actions";
import {
  hasReviewDifference,
  selectActiveVersionId,
  selectClauseTree,
  selectDraftVersion,
  selectRole,
  selectSaving,
} from "../../core/state/review.selectors";
import {
  ClarificationTagComponent,
  ClauseTypeTagComponent,
  StatusTagComponent,
} from "../../shared/status-tag.component";

@Component({
  selector: "app-clauses-page",
  imports: [
    DatePipe,
    RouterLink,
    FormsModule,
    ReactiveFormsModule,
    AccordionModule,
    ButtonModule,
    DatePickerModule,
    DialogModule,
    InputNumberModule,
    InputTextModule,
    SelectModule,
    TagModule,
    TextareaModule,
    TreeModule,
    StatusTagComponent,
    ClauseTypeTagComponent,
    ClarificationTagComponent,
  ],
  templateUrl: "./clauses.page.html",
  styleUrl: "./clauses.page.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ClausesPage {
  private readonly store = inject(Store);

  readonly clauseTree = toSignal(this.store.select(selectClauseTree), {
    initialValue: [],
  });
  readonly treeNodes = computed(() => this.toTreeNodes(this.clauseTree()));
  readonly role = toSignal(this.store.select(selectRole), {
    initialValue: "reviewer_a",
  });
  readonly activeVersionId = toSignal(
    this.store.select(selectActiveVersionId),
    { initialValue: "" },
  );
  readonly draftVersion = toSignal(this.store.select(selectDraftVersion), {
    initialValue: undefined,
  });
  readonly saving = toSignal(this.store.select(selectSaving), {
    initialValue: false,
  });
  readonly selectedTreeKey = signal<string | null>(null);
  readonly selectedSupplierId = signal<string | null>(null);
  readonly clarificationVisible = signal(false);
  readonly selectedClause = computed(() => {
    const key = this.selectedTreeKey();
    if (!key) {
      return this.clauseTree()[0] ?? null;
    }
    return this.findClause(this.treeNodes(), key) ?? null;
  });
  readonly selectedResponse = computed<VersionedResponseView | null>(() => {
    const clause = this.selectedClause();
    const versionId = this.activeVersionId();
    if (!clause || !versionId) {
      return null;
    }
    const match = clause.responses.find(
      (response) => response.supplierId === this.selectedSupplierId(),
    );
    const target = match ?? clause.responses[0];
    return target ? versionedResponse(target, versionId) : null;
  });
  readonly canReview = computed(
    () => this.role() !== "procurement" && this.draftVersion() !== undefined,
  );
  readonly clauseRisks = computed(() => {
    const clause = this.selectedClause();
    const versionId = this.activeVersionId();
    if (!clause || !versionId) {
      return [];
    }
    const risks: string[] = [];
    const views = clause.responses.map((response) =>
      versionedResponse(response, versionId),
    );
    if (
      clause.type === "mandatory" &&
      views.some(
        (view) =>
          view.derivedStatus === "pending" ||
          view.derivedStatus === "clarification",
      )
    ) {
      risks.push("存在尚未明确结论的否决项");
    }
    if (
      views.some((view) => hasReviewDifference(view, versionId))
    ) {
      risks.push("不同评审员意见存在分歧，必须保留并进入小组复核");
    }
    if (
      views.some((view) =>
        view.scopedClarifications.some(
          (clarification) => clarification.status === "overdue",
        ),
      )
    ) {
      risks.push("存在逾期澄清，不得直接形成最终结论");
    }
    const duplicatedProof = new Set<string>();
    views.forEach((view) => {
      if (
        views.filter(
          (candidate) =>
            candidate.proofFingerprint === view.proofFingerprint,
        ).length > 1
      ) {
        duplicatedProof.add(view.proofFingerprint);
      }
    });
    if (duplicatedProof.size > 0) {
      risks.push("同一证明文件在多个响应中重复使用，需要确认适用范围");
    }
    return risks;
  });

  readonly decisionOptions = (
    Object.entries(complianceLabels) as Array<
      [ComplianceStatus, string]
    >
  ).map(([value, label]) => ({ value, label }));

  readonly assessmentForm = new FormGroup({
    decision: new FormControl<ComplianceStatus>("compliant", {
      nonNullable: true,
      validators: [Validators.required],
    }),
    score: new FormControl(0, {
      nonNullable: true,
      validators: [Validators.min(0)],
    }),
    comment: new FormControl("", {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(6)],
    }),
  });

  readonly clarificationForm = new FormGroup({
    requestText: new FormControl("", {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(6)],
    }),
    dueAt: new FormControl(
      new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      { nonNullable: true },
    ),
  });

  readonly minimumClarificationDate = new Date();

  nodeTemplateData(node: TreeNode): Clause {
    return node.data as Clause;
  }

  selectNode(node: TreeNode): void {
    const clause = node.data as Clause;
    this.selectedTreeKey.set(clause.id);
    this.selectedSupplierId.set(clause.responses[0]?.supplierId ?? null);
    this.resetAssessmentForm(clause.responses[0]);
  }

  selectResponse(response: SupplierResponse): void {
    this.selectedSupplierId.set(response.supplierId);
    this.resetAssessmentForm(response);
  }

  submitAssessment(): void {
    const view = this.selectedResponse();
    const clause = this.selectedClause();
    const draft = this.draftVersion();
    if (this.saving() || !view || !clause || !draft || this.assessmentForm.invalid) {
      this.assessmentForm.markAllAsTouched();
      return;
    }
    if (!this.canReview()) {
      return;
    }
    const value = this.assessmentForm.getRawValue();
    this.store.dispatch(
      ReviewActions.submitAssessment({
        input: {
          responseId: view.id,
          decision: value.decision,
          score: clause.type === "scoring" ? value.score : 0,
          comment: value.comment,
          reviewer: roleProfiles[this.role()].name,
          role: this.role(),
          clientToken: createClientToken(),
          versionId: draft.id,
          expectedRevision: draft.revision,
        },
      }),
    );
  }

  openClarificationDialog(): void {
    this.clarificationForm.reset({
      requestText: "",
      dueAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    });
    this.clarificationVisible.set(true);
  }

  submitClarification(): void {
    const view = this.selectedResponse();
    const draft = this.draftVersion();
    if (this.saving() || !view || !draft || this.clarificationForm.invalid) {
      this.clarificationForm.markAllAsTouched();
      return;
    }
    const value = this.clarificationForm.getRawValue();
    this.store.dispatch(
      ReviewActions.requestClarification({
        input: {
          responseId: view.id,
          requestText: value.requestText,
          dueAt: value.dueAt.toISOString(),
          actor: roleProfiles[this.role()].name,
          clientToken: createClientToken(),
          versionId: draft.id,
          expectedRevision: draft.revision,
        },
      }),
    );
    this.clarificationVisible.set(false);
  }

  /** 模板使用：按当前版本展示响应状态。 */
  scopedView(response: SupplierResponse): VersionedResponseView {
    const versionId = this.activeVersionId();
    return versionedResponse(response, versionId);
  }

  latestOpinion(
    response: SupplierResponse,
    reviewer: string,
  ): string | undefined {
    return response.reviews
      .filter((review) => review.versionId === this.activeVersionId())
      .find((review) => review.reviewer === reviewer)?.comment;
  }

  private findClause(
    nodes: readonly TreeNode<Clause>[],
    clauseId: string,
  ): Clause | undefined {
    for (const node of nodes) {
      if (node.data?.id === clauseId) {
        return node.data;
      }
      const child = this.findClause(node.children ?? [], clauseId);
      if (child) {
        return child;
      }
    }
    return undefined;
  }

  private toTreeNodes(nodes: readonly Clause[]): TreeNode<Clause>[] {
    return nodes.map((clause) => ({
      key: clause.id,
      label: `${clause.code} ${clause.title}`,
      data: clause,
      children: this.toTreeNodes(clause.children ?? []),
    }));
  }

  private resetAssessmentForm(response: SupplierResponse | undefined): void {
    if (!response) {
      return;
    }
    const view = versionedResponse(response, this.activeVersionId());
    const latest = [...view.scopedReviews].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    )[0];
    this.assessmentForm.reset({
      decision: latest?.decision ?? view.derivedStatus,
      score: latest?.score ?? response.claimedScore,
      comment: "",
    });
  }
}
