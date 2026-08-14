import type { ProviderId, ProviderProtocol } from "./editor-data";

export type DesktopPlatform = "darwin" | "win32" | "linux";

export type DesktopInfo = {
  version: string;
  platform: DesktopPlatform;
  packaged: boolean;
};

export type DesktopUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error"
  | "unsupported";

export type DesktopUpdateState = {
  status: DesktopUpdateStatus;
  currentVersion: string;
  version?: string;
  releaseDate?: string;
  releaseNotes?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  message: string;
};

export type DesktopProjectSnapshot = {
  schemaVersion: 1;
  projectName: string;
  history: string[];
  historyIndex: number;
  codeDraft: string;
  projectBaseline: string;
  savedHtml: string;
  intentionalBlankFlags?: boolean[];
  savedAt: string;
};

export type DesktopPreferences = {
  schemaVersion: 1;
  modelConfig: {
    providerId: ProviderId;
    protocol: ProviderProtocol;
    baseUrl: string;
    model: string;
  };
  savedAt: string;
};

export type DesktopCredentialSlot =
  | "shared-model-api-key"
  | "chat-model-api-key";

export type DesktopCredentialErrorCode =
  | "encryption-unavailable"
  | "invalid-credential-slot"
  | "invalid-credential-value"
  | "credential-file-corrupt"
  | "credential-decryption-failed"
  | "credential-encryption-failed"
  | "credential-storage-error";

export type DesktopCredentialError = {
  ok: false;
  error: {
    code: DesktopCredentialErrorCode;
    message: string;
  };
};

export type DesktopCredentialStatusResult =
  | {
      ok: true;
      slot: DesktopCredentialSlot;
      available: true;
      exists: boolean;
    }
  | DesktopCredentialError;

export type DesktopCredentialReadResult =
  | {
      ok: true;
      slot: DesktopCredentialSlot;
      value: string | null;
    }
  | DesktopCredentialError;

export type DesktopCredentialMutationResult =
  | {
      ok: true;
      slot: DesktopCredentialSlot;
      exists: boolean;
    }
  | DesktopCredentialError;

export type DesktopCollaborationAttachmentReference =
  `canvasly-attachment:v1:${string}`;

export type DesktopCollaborationAttachment = {
  id: string;
  name: string;
  mimeType: string;
  kind: "image" | "document";
  sizeBytes: number;
  sizeLabel?: string;
  reference: DesktopCollaborationAttachmentReference;
};

type DesktopCollaborationAttachmentPayloadBase = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes?: number;
  sizeLabel?: string;
};

export type DesktopCollaborationAttachmentPayload =
  | (DesktopCollaborationAttachmentPayloadBase & {
      kind: "image";
      data: string;
      text?: never;
    })
  | (DesktopCollaborationAttachmentPayloadBase & {
      kind: "document";
      text: string;
      data?: never;
    });

export type DesktopStoredCollaborationAttachment =
  DesktopCollaborationAttachmentPayload & {
    sizeBytes: number;
    reference: DesktopCollaborationAttachmentReference;
  };

export type DesktopAttachmentErrorCode =
  | "invalid-attachment"
  | "attachment-too-large"
  | "invalid-attachment-reference"
  | "attachment-not-found"
  | "attachment-corrupt"
  | "attachment-storage-error";

export type DesktopAttachmentError = {
  ok: false;
  error: {
    code: DesktopAttachmentErrorCode;
    message: string;
  };
  queueMustRemainPaused?: true;
};

export type DesktopAttachmentStoreResult =
  | {
      ok: true;
      attachment: DesktopStoredCollaborationAttachment;
    }
  | DesktopAttachmentError;

export type DesktopAttachmentReadResult = DesktopAttachmentStoreResult;

export type DesktopAttachmentDeleteResult =
  | {
      ok: true;
      reference: DesktopCollaborationAttachmentReference;
      deleted: boolean;
    }
  | DesktopAttachmentError;

export type DesktopCollaborationCitation = {
  id: string;
  title: string;
  url: string;
  snippet?: string;
};

export type DesktopCoworkSuggestion = {
  label: string;
  prompt: string;
  description?: string;
};

export type DesktopCoworkReport = {
  status: "completed" | "partial" | "blocked";
  updates: string[];
  issues: string[];
  suggestions: DesktopCoworkSuggestion[];
};

export type DesktopCoworkStrategy = "auto" | "direct" | "mission";

export type DesktopCoworkPlan = {
  strategy: "mission";
  objective: string;
  summary: string;
  assumptions: string[];
  steps: Array<{
    id: string;
    title: string;
    description: string;
  }>;
  acceptanceCriteria: string[];
  openQuestions: string[];
};

export type DesktopCollaborationMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  detail?: string;
  error?: boolean;
  jobId?: string;
  queueState?: "steer" | "queued" | "interrupted";
  report?: DesktopCoworkReport;
  plan?: DesktopCoworkPlan;
  citations?: DesktopCollaborationCitation[];
  streamState?: "completed" | "stopped";
  phase?: {
    stage: string;
    message: string;
  };
  handoffCardId?: string;
};

export type DesktopHandoffCard = {
  id: string;
  title: string;
  objective: string;
  decisions: string[];
  references: Array<{
    title: string;
    url?: string;
    note: string;
  }>;
  constraints: string[];
  openQuestions: string[];
  instruction: string;
  sourceMessageIds: string[];
  createdAt: string;
};

export type DesktopNonSecretModelConfig = {
  providerId: ProviderId;
  protocol: ProviderProtocol;
  baseUrl: string;
  model: string;
};

export type DesktopCollaborationSelection = {
  type: "element" | "region" | "drawing";
  label: string;
  selector?: string;
  html?: string;
  targets?: Array<{
    label: string;
    selector: string;
    html: string;
    rect: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
  }>;
  anchors?: string[];
  placement?: {
    relation: "prepend" | "between" | "append";
    axis: "horizontal" | "vertical";
    parentSelector: string;
    previousSelector?: string;
    nextSelector?: string;
    xPercent: number;
    yPercent: number;
    parentPath?: number[];
    childIndex?: number;
    parentAnchor?: string;
    previousAnchor?: string;
    nextAnchor?: string;
    slotAnchor?: string;
  };
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

export type DesktopCoworkTask = {
  id: string;
  messageId: string;
  mode: "cowork";
  instruction: string;
  attachments: DesktopCollaborationAttachment[];
  selection: DesktopCollaborationSelection | null;
  priority: "normal" | "steer" | "queued";
  interactionMode?: "auto" | "plan" | "agent";
  strategy?: DesktopCoworkStrategy;
  modelConfig: DesktopNonSecretModelConfig;
  handoffCardId?: string;
  restoreState?: "paused" | "interrupted";
};

export type DesktopCollaborationState = {
  schemaVersion: 1;
  unifiedMessages: DesktopCollaborationMessage[];
  activeMode: "auto" | "plan" | "agent";
  pane: { open: boolean; width: number };
  pendingAttachments: DesktopCollaborationAttachment[];
  coworkMessages: DesktopCollaborationMessage[];
  chatMessages: DesktopCollaborationMessage[];
  handoffCards: DesktopHandoffCard[];
  coworkQueue: DesktopCoworkTask[];
  coworkQueuePaused: boolean;
  activeCoworkTask: DesktopCoworkTask | null;
  coworkStrategy: DesktopCoworkStrategy;
  panes: {
    cowork: { open: boolean; width: number };
    chat: { open: boolean; width: number };
    activeMobilePane: "canvas" | "cowork" | "chat";
    layout: "parallel" | "switch";
  };
  chatModelOverride: DesktopNonSecretModelConfig | null;
  attachments: {
    cowork: DesktopCollaborationAttachment[];
    chat: DesktopCollaborationAttachment[];
  };
  savedAt: string;
};

type DesktopSaveResult = {
  savedAt: string;
};

type SaveBeforeUnloadResult =
  | { ok: true }
  | { ok: false; message: string };

export type CanvaslyDesktopApi = {
  getInfo(): Promise<DesktopInfo>;
  loadProject(): Promise<DesktopProjectSnapshot | null>;
  saveProject(snapshot: DesktopProjectSnapshot): Promise<DesktopSaveResult>;
  saveProjectBeforeUnload(
    snapshot: DesktopProjectSnapshot,
  ): SaveBeforeUnloadResult;
  loadPreferences(): Promise<DesktopPreferences | null>;
  savePreferences(
    preferences: DesktopPreferences,
  ): Promise<DesktopSaveResult>;
  savePreferencesBeforeUnload(
    preferences: DesktopPreferences,
  ): SaveBeforeUnloadResult;
  loadCollaboration(): Promise<DesktopCollaborationState | null>;
  quarantineCollaboration(): Promise<{ backupName: string }>;
  saveCollaboration(
    state: DesktopCollaborationState,
  ): Promise<DesktopSaveResult>;
  saveCollaborationBeforeUnload(
    state: DesktopCollaborationState,
  ): SaveBeforeUnloadResult;
  getCredentialStatus(
    slot: DesktopCredentialSlot,
  ): Promise<DesktopCredentialStatusResult>;
  readCredential(
    slot: DesktopCredentialSlot,
  ): Promise<DesktopCredentialReadResult>;
  writeCredential(
    slot: DesktopCredentialSlot,
    value: string,
  ): Promise<DesktopCredentialMutationResult>;
  clearCredential(
    slot: DesktopCredentialSlot,
  ): Promise<DesktopCredentialMutationResult>;
  storeCollaborationAttachment(
    attachment: DesktopCollaborationAttachmentPayload,
  ): Promise<DesktopAttachmentStoreResult>;
  readCollaborationAttachment(
    reference: DesktopCollaborationAttachmentReference,
  ): Promise<DesktopAttachmentReadResult>;
  deleteCollaborationAttachment(
    reference: DesktopCollaborationAttachmentReference,
  ): Promise<DesktopAttachmentDeleteResult>;
  getUpdateState(): Promise<DesktopUpdateState>;
  checkForUpdates(): Promise<DesktopUpdateState>;
  downloadUpdate(): Promise<DesktopUpdateState>;
  installUpdate(): Promise<{ installing: true }>;
  onUpdateState(
    listener: (state: DesktopUpdateState) => void,
  ): () => void;
};

declare global {
  interface Window {
    canvaslyDesktop?: CanvaslyDesktopApi;
  }
}

export function desktopErrorMessage(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "桌面功能发生未知错误";
}

export function formatDesktopBytes(bytes: number | undefined) {
  if (!bytes || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
