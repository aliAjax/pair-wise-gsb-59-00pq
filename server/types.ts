export type ClauseType = "mandatory" | "scoring" | "evidence";
export type ComplianceStatus =
  | "compliant"
  | "deviation"
  | "clarification"
  | "pending";
export type ReviewRole =
  | "procurement"
  | "reviewer_a"
  | "reviewer_b"
  | "chair";
export type ClarificationStatus = "open" | "responded" | "overdue";
export type VersionStatus = "draft" | "finalized";

export interface Clause {
  id: string;
  code: string;
  title: string;
  category: string;
  requirement: string;
  type: ClauseType;
  weight: number;
  parentId?: string;
  evidenceRequired: boolean;
  order: number;
}

export interface ReviewerOpinion {
  id: string;
  responseId: string;
  /** 归属的评审版本 ID；只有当前草稿版本可以新增意见。 */
  versionId: string;
  reviewer: string;
  role: ReviewRole;
  decision: ComplianceStatus;
  score: number;
  comment: string;
  createdAt: string;
  /** 内部幂等键，不对外暴露，用于失败重试时定位首次入库记录。 */
  clientMutationId?: string;
}

export interface Clarification {
  id: string;
  responseId: string;
  clauseId: string;
  /** 归属的评审版本 ID；定稿后旧版本的澄清不得再回复。 */
  versionId: string;
  round: number;
  requestText: string;
  supplierResponse?: string;
  requestedAt: string;
  dueAt: string;
  respondedAt?: string;
  status: ClarificationStatus;
  /** 内部幂等键，不对外暴露，用于失败重试时定位首次入库记录。 */
  clientMutationId?: string;
}

export interface SupplierResponse {
  id: string;
  clauseId: string;
  supplierId: string;
  supplierName: string;
  status: ComplianceStatus;
  responseText: string;
  claimedScore: number;
  attachmentName: string;
  proofFingerprint: string;
  submittedBy: string;
  submittedAt: string;
  reviewRound: number;
  reviews: ReviewerOpinion[];
  clarifications: Clarification[];
}

/**
 * 定稿时刻服务端锁定的不可变快照。版本历史、比对与导出都从快照读取计数，
 * 定稿后再提交的意见只属于新草稿，不会改变任何已定稿版本的数字。
 */
export interface VersionSnapshot {
  contentHash: string;
  opinionCount: number;
  clarificationCount: number;
  responses: Array<{
    responseId: string;
    opinionCount: number;
    clarificationCount: number;
  }>;
}

export interface ReviewVersion {
  id: string;
  version: string;
  label: string;
  status: VersionStatus;
  createdAt: string;
  createdBy: string;
  signedBy: string[];
  clauseCount: number;
  responseCount: number;
  contentHash: string;
  /** 草稿为 null；定稿时按服务端此刻数据锁定。 */
  snapshot: VersionSnapshot | null;
  /** 内部幂等键，不对外暴露，用于定稿重试回放。 */
  lockMutationId?: string;
}

export interface AuditLog {
  id: string;
  at: string;
  actor: string;
  action: string;
  entity: string;
  detail: string;
}

export interface DashboardStats {
  totalClauses: number;
  mandatoryCount: number;
  pendingReviews: number;
  /** 当前草稿下独立意见总数，与比对、版本历史读到的计数口径一致。 */
  opinionCount: number;
  differences: number;
  overdueClarifications: number;
  reusedProofs: number;
  activeVersion: string;
}

export interface ReviewDatabase {
  clauses: Clause[];
  responses: SupplierResponse[];
  versions: ReviewVersion[];
  auditLogs: AuditLog[];
  suppliers: Array<{ id: string; name: string }>;
  /** 每次服务端写入单调递增，前端据此丢弃过期刷新，避免并发提交互相覆盖。 */
  revision: number;
  /** 已处理的幂等键，保证网络重试下同一意见/回复只入库一次。 */
  processedMutations: string[];
}

export interface AssessmentInput {
  responseId: string;
  decision: ComplianceStatus;
  score: number;
  comment: string;
  reviewer: string;
  role: ReviewRole;
  /** 客户端载入草稿时拿到的版本 ID；与服务端当前草稿不一致即返回版本冲突。 */
  baseVersionId: string;
  /** 客户端生成的幂等键，同键重试返回首次结果而不重复入库。 */
  clientMutationId: string;
}

export interface ClarificationInput {
  responseId: string;
  requestText: string;
  dueAt: string;
  actor: string;
  baseVersionId: string;
  clientMutationId: string;
}

export interface ClarificationResponseInput {
  clarificationId: string;
  responseText: string;
  actor: string;
  baseVersionId: string;
  clientMutationId: string;
}

export interface FinalizeVersionInput {
  label: string;
  actor: string;
  role: ReviewRole;
  baseVersionId: string;
  clientMutationId: string;
}
