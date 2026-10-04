import { DatePipe } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import {
  FormControl,
  FormGroup,
  FormsModule,
  ReactiveFormsModule,
  Validators,
} from "@angular/forms";
import { toSignal } from "@angular/core/rxjs-interop";
import { Store } from "@ngrx/store";
import { ButtonModule } from "primeng/button";
import { DialogModule } from "primeng/dialog";
import { InputTextModule } from "primeng/inputtext";
import { TableModule } from "primeng/table";
import { TagModule } from "primeng/tag";
import { TextareaModule } from "primeng/textarea";
import {
  createClientToken,
  roleProfiles,
  versionedResponse,
  type Clarification,
  type Clause,
  type VersionedResponseView,
} from "../../core/models/review.models";
import { ReviewActions } from "../../core/state/review.actions";
import {
  hasReviewDifference,
  selectActiveVersionId,
  selectClauses,
  selectDraftVersion,
  selectPendingClarifications,
  selectRole,
  selectSaving,
  selectVersions,
} from "../../core/state/review.selectors";
import {
  ClarificationTagComponent,
  StatusTagComponent,
  VersionTagComponent,
} from "../../shared/status-tag.component";

interface PendingClarification {
  clause: Clause;
  response: VersionedResponseView;
  clarification: Clarification;
}

interface DifferenceItem {
  clause: Clause;
  response: VersionedResponseView;
}

@Component({
  selector: "app-review-page",
  imports: [
    DatePipe,
    FormsModule,
    ReactiveFormsModule,
    ButtonModule,
    DialogModule,
    InputTextModule,
    TableModule,
    TagModule,
    TextareaModule,
    ClarificationTagComponent,
    StatusTagComponent,
    VersionTagComponent,
  ],
  templateUrl: "./review.page.html",
  styleUrl: "./review.page.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReviewPage {
  private readonly store = inject(Store);

  readonly versions = toSignal(this.store.select(selectVersions), {
    initialValue: [],
  });
  readonly clauses = toSignal(this.store.select(selectClauses), {
    initialValue: [],
  });
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
  readonly pendingClarifications = toSignal(
    this.store.select(selectPendingClarifications),
    { initialValue: [] as PendingClarification[] },
  );
  readonly finalizeVisible = signal(false);
  readonly responseVisible = signal(false);
  readonly selectedClarification = signal<PendingClarification | null>(null);
  readonly canFinalize = computed(
    () => this.role() === "chair" && this.draftVersion() !== undefined,
  );
  readonly canRespond = computed(() =>
    ["procurement", "chair"].includes(this.role()),
  );
  readonly differences = computed<DifferenceItem[]>(() => {
    const versionId = this.activeVersionId();
    return this.clauses().flatMap((clause) =>
      clause.responses
        .filter((response) => hasReviewDifference(response, versionId))
        .map((response) => ({
          clause,
          response: versionedResponse(response, versionId),
        })),
    );
  });
  readonly finalizedCount = computed(
    () => this.versions().filter((version) => version.status === "finalized").length,
  );
  /** 当前草稿的实时计数，与版本历史表展示同一数据源。 */
  readonly draftStats = computed(() => this.draftVersion());

  readonly finalizeForm = new FormGroup({
    label: new FormControl("", {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(4)],
    }),
  });
  readonly responseForm = new FormGroup({
    responseText: new FormControl("", {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(6)],
    }),
  });

  openFinalize(): void {
    this.finalizeForm.reset({ label: "技术响应符合性评审汇总" });
    this.finalizeVisible.set(true);
  }

  finalizeVersion(): void {
    const draft = this.draftVersion();
    if (
      this.saving() ||
      !this.canFinalize() ||
      this.finalizeForm.invalid ||
      !draft
    ) {
      this.finalizeForm.markAllAsTouched();
      return;
    }
    this.store.dispatch(
      ReviewActions.finalizeVersion({
        input: {
          label: this.finalizeForm.controls.label.value,
          actor: roleProfiles[this.role()].name,
          role: this.role(),
          versionId: draft.id,
          expectedRevision: draft.revision,
        },
      }),
    );
    this.finalizeVisible.set(false);
  }

  openResponse(item: PendingClarification): void {
    this.selectedClarification.set(item);
    this.responseForm.reset({ responseText: "" });
    this.responseVisible.set(true);
  }

  respondClarification(): void {
    const item = this.selectedClarification();
    const draft = this.draftVersion();
    if (
      this.saving() ||
      !item ||
      !draft ||
      !this.canRespond() ||
      this.responseForm.invalid
    ) {
      this.responseForm.markAllAsTouched();
      return;
    }
    this.store.dispatch(
      ReviewActions.respondClarification({
        input: {
          clarificationId: item.clarification.id,
          responseText: this.responseForm.controls.responseText.value,
          actor: roleProfiles[this.role()].name,
          clientToken: createClientToken(),
          versionId: draft.id,
          expectedRevision: draft.revision,
        },
      }),
    );
    this.responseVisible.set(false);
  }
}
