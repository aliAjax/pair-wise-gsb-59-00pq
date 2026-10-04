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
  reviewer: string;
  role: ReviewRole;
  decision: ComplianceStatus;
  score: number;
  comment: string;
  createdAt: string;
  /** 该意见归属的评审版本；定稿后历史版本的意见保持只读快照。 */
  versionId: string;
  /** 客户端幂等键，网络重试只入库一次。 */
  clientToken?: string;
}

export interface Clarification {
  id: string;
  responseId: string;
  clauseId: string;
  round: number;
  requestText: string;
  supplierResponse?: string;
  requestedAt: string;
  dueAt: string;
  respondedAt?: string;
  status: ClarificationStatus;
  /** 澄清发起时归属的评审版本。 */
  versionId: string;
  /** 发起澄清的客户端幂等键。 */
  clientToken?: string;
  /** 登记回复的客户端幂等键。 */
  responseToken?: string;
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
  /** 快照锁定时刻归属本版本的独立意见数。 */
  opinionCount: number;
  /** 快照锁定时刻归属本版本的澄清记录数。 */
  clarificationCount: number;
  /** 快照锁定时刻仍有未完成澄清的响应数。 */
  pendingClarificationCount: number;
  /** 快照锁定时刻独立意见存在分歧的响应数。 */
  differenceCount: number;
  /** 快照锁定时刻至少有一条独立意见的响应数。 */
  reviewedResponseCount: number;
  /** 草稿的乐观并发修订号；每次提交递增，定稿后冻结。 */
  revision: number;
  /** 草稿期间为空字符串，定稿时按服务端此刻数据计算。 */
  contentHash: string;
}

export interface AuditLog {
  id: string;
  at: string;
  actor: string;
  action: string;
  entity: string;
  detail: string;
  /** 操作发生时归属的评审版本；旧数据迁移后标记为未归属。 */
  versionId?: string;
}

export interface DashboardStats {
  totalClauses: number;
  mandatoryCount: number;
  pendingReviews: number;
  differences: number;
  overdueClarifications: number;
  reusedProofs: number;
  activeVersion: string;
  activeVersionId: string;
  activeVersionRevision: number;
  opinionCount: number;
  clarificationCount: number;
}

export interface ReviewDatabase {
  clauses: Clause[];
  responses: SupplierResponse[];
  versions: ReviewVersion[];
  auditLogs: AuditLog[];
  suppliers: Array<{ id: string; name: string }>;
}

export interface AssessmentInput {
  responseId: string;
  decision: ComplianceStatus;
  score: number;
  comment: string;
  reviewer: string;
  role: ReviewRole;
  /** 客户端生成的幂等键，失败重试保持不变。 */
  clientToken: string;
  /** 提交时所依据的草稿版本 ID，旧版本提交返回冲突。 */
  versionId: string;
  /** 载入草稿时的修订号，服务端不匹配则返回冲突。 */
  expectedRevision: number;
}

export interface ClarificationInput {
  responseId: string;
  requestText: string;
  dueAt: string;
  actor: string;
  clientToken: string;
  versionId: string;
  expectedRevision: number;
}

export interface ClarificationResponseInput {
  clarificationId: string;
  responseText: string;
  actor: string;
  clientToken: string;
  versionId: string;
  expectedRevision: number;
}

export interface FinalizeVersionInput {
  label: string;
  actor: string;
  role: ReviewRole;
  versionId: string;
  expectedRevision: number;
}
