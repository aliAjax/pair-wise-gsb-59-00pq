import { DatePipe } from "@angular/common";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from "@angular/core";
import { toSignal } from "@angular/core/rxjs-interop";
import {
  FormControl,
  FormGroup,
  FormsModule,
  ReactiveFormsModule,
  Validators,
} from "@angular/forms";
import { Store } from "@ngrx/store";
import { ButtonModule } from "primeng/button";
import { DialogModule } from "primeng/dialog";
import { InputTextModule } from "primeng/inputtext";
import { TableModule } from "primeng/table";
import { TagModule } from "primeng/tag";
import { TextareaModule } from "primeng/textarea";
import {
  roleProfiles,
  type Clarification,
  type Clause,
  type SupplierResponse,
} from "../../core/models/review.models";
import { ReviewActions } from "../../core/state/review.actions";
import {
  hasReviewDifference,
  selectClauses,
  selectDraftVersion,
  selectPendingClarifications,
  selectRevision,
  selectRole,
  selectVersions,
} from "../../core/state/review.selectors";
import {
  createClientMutationId,
  snapshotCounts,
} from "../../core/state/review.utils";
import {
  ClarificationTagComponent,
  StatusTagComponent,
  VersionTagComponent,
} from "../../shared/status-tag.component";

interface PendingClarification {
  clause: Clause;
  response: SupplierResponse;
  clarification: Clarification;
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
  readonly draftVersion = toSignal(this.store.select(selectDraftVersion), {
    initialValue: undefined,
  });
  readonly revision = toSignal(this.store.select(selectRevision), {
    initialValue: 0,
  });
  readonly pendingClarifications = toSignal(
    this.store.select(selectPendingClarifications),
    { initialValue: [] as PendingClarification[] },
  );
  readonly finalizeVisible = signal(false);
  readonly responseVisible = signal(false);
  readonly selectedClarification = signal<PendingClarification | null>(null);
  /** 单次逻辑提交一个幂等键；服务端修订号增长说明上次提交已成功，随后轮换。 */
  private readonly finalizeMutationId = signal(createClientMutationId("fin"));
  private readonly responseMutationId = signal(createClientMutationId("resp"));
  private lastRevision = 0;
  readonly canFinalize = computed(
    () => this.role() === "chair" && Boolean(this.draftVersion()),
  );
  readonly canRespond = computed(() =>
    ["procurement", "chair"].includes(this.role()),
  );
  readonly differences = computed(() =>
    this.clauses().flatMap((clause) =>
      clause.responses
        .filter(hasReviewDifference)
        .map((response) => ({ clause, response })),
    ),
  );
  readonly finalizedCount = computed(
    () => this.versions().filter((version) => version.status === "finalized").length,
  );
  /** 定稿版本快照内锁定的独立意见总数，与概览、导出口径一致。 */
  readonly lockedOpinionCount = computed(() =>
    this.versions()
      .filter((version) => version.status === "finalized")
      .reduce((total, version) => total + snapshotCounts(version).opinionCount, 0),
  );

  readonly snapshotCounts = snapshotCounts;

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

  constructor() {
    effect(() => {
      const revision = this.revision();
      if (revision > this.lastRevision) {
        this.lastRevision = revision;
        // 上一次 mutation 已落库：轮换键，下一次提交是新逻辑操作；
        // 失败时 revision 不变，原键保留以便按原意见重试。
        this.finalizeMutationId.set(createClientMutationId("fin"));
        this.responseMutationId.set(createClientMutationId("resp"));
      }
    });
  }

  openFinalize(): void {
    this.finalizeForm.reset({ label: "技术响应符合性评审汇总" });
    this.finalizeVisible.set(true);
  }

  finalizeVersion(): void {
    const draft = this.draftVersion();
    if (!this.canFinalize() || !draft || this.finalizeForm.invalid) {
      this.finalizeForm.markAllAsTouched();
      return;
    }
    this.store.dispatch(
      ReviewActions.finalizeVersion({
        input: {
          label: this.finalizeForm.controls.label.value,
          actor: roleProfiles[this.role()].name,
          role: this.role(),
          baseVersionId: draft.id,
          clientMutationId: this.finalizeMutationId(),
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
          baseVersionId: draft.id,
          clientMutationId: this.responseMutationId(),
        },
      }),
    );
    this.responseVisible.set(false);
  }
}
