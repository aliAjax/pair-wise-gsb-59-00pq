import { DatePipe } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { toSignal } from "@angular/core/rxjs-interop";
import { Store } from "@ngrx/store";
import { ButtonModule } from "primeng/button";
import { InputTextModule } from "primeng/inputtext";
import { SelectModule } from "primeng/select";
import { TableModule } from "primeng/table";
import { ReviewActions } from "../../core/state/review.actions";
import {
  selectActiveVersionId,
  selectAuditLogs,
  selectRole,
  selectVersions,
} from "../../core/state/review.selectors";
import { roleProfiles } from "../../core/models/review.models";

const UNASSIGNED_VERSION = "unassigned";

@Component({
  selector: "app-audit-page",
  imports: [
    DatePipe,
    FormsModule,
    ButtonModule,
    InputTextModule,
    SelectModule,
    TableModule,
  ],
  templateUrl: "./audit.page.html",
  styleUrl: "./audit.page.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuditPage {
  private readonly store = inject(Store);

  readonly roleProfiles = roleProfiles;
  readonly logs = toSignal(this.store.select(selectAuditLogs), {
    initialValue: [],
  });
  readonly versions = toSignal(this.store.select(selectVersions), {
    initialValue: [],
  });
  readonly activeVersionId = toSignal(
    this.store.select(selectActiveVersionId),
    { initialValue: "" },
  );
  readonly role = toSignal(this.store.select(selectRole), {
    initialValue: "reviewer_a",
  });
  readonly keyword = signal("");
  readonly action = signal("all");
  readonly versionFilter = signal<"active" | "all">("active");

  /** 版本 ID 到“Vx 名称”的映射，导出与表格共用。 */
  private readonly versionLabel = (versionId?: string): string => {
    if (!versionId) {
      return "未归属";
    }
    if (versionId === UNASSIGNED_VERSION) {
      return "旧数据（已迁入当前草稿）";
    }
    const version = this.versions().find((item) => item.id === versionId);
    return version ? `${version.version} ${version.label}` : versionId;
  };

  readonly actionOptions = computed(() => [
    { label: "全部动作", value: "all" },
    ...Array.from(new Set(this.logs().map((log) => log.action))).map(
      (item) => ({ label: item, value: item }),
    ),
  ]);
  readonly versionFilterOptions = [
    { label: "当前工作版", value: "active" as const },
    { label: "全部版本", value: "all" as const },
  ];
  readonly filteredLogs = computed(() => {
    const keyword = this.keyword().trim().toLowerCase();
    const action = this.action();
    const activeVersionId = this.activeVersionId();
    return this.logs().filter((log) => {
      const matchesVersion =
        this.versionFilter() === "all" || log.versionId === activeVersionId;
      const matchesAction = action === "all" || log.action === action;
      const matchesKeyword =
        !keyword ||
        [log.actor, log.action, log.entity, log.detail, log.versionId ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(keyword);
      return matchesVersion && matchesAction && matchesKeyword;
    });
  });
  /** 用于表格和导出展示的版本标签。 */
  readonly versionLabelFor = (log: { versionId?: string }): string =>
    this.versionLabel(log.versionId);
  readonly finalVersion = computed(() =>
    this.versions().find((version) => version.status === "finalized"),
  );
  readonly finalizedCount = computed(
    () => this.versions().filter((version) => version.status === "finalized").length,
  );

  exportJson(): void {
    const rows = this.filteredLogs().map((log) => ({
      时间: log.at,
      操作人: log.actor,
      动作: log.action,
      对象: log.entity,
      归属版本: this.versionLabel(log.versionId),
      详情: log.detail,
    }));
    this.download(
      "procurement-review-audit.json",
      JSON.stringify(rows, null, 2),
      "application/json;charset=utf-8",
    );
  }

  exportCsv(): void {
    const header = ["时间", "操作人", "动作", "对象", "归属版本", "详情"];
    const rows = this.filteredLogs().map((log) => [
      log.at,
      log.actor,
      log.action,
      log.entity,
      this.versionLabel(log.versionId),
      log.detail,
    ]);
    const csv = [header, ...rows]
      .map((row) =>
        row.map((value) => `"${value.replaceAll('"', '""')}"`).join(","),
      )
      .join("\n");
    this.download(
      "procurement-review-audit.csv",
      csv,
      "text/csv;charset=utf-8",
    );
  }

  resetReviewData(): void {
    this.store.dispatch(ReviewActions.resetReviewData());
  }

  private download(filename: string, content: string, type: string): void {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }
}
