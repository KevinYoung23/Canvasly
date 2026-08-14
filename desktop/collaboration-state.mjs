import { randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  isCollaborationAttachmentReference,
  MAX_DESKTOP_DOCUMENT_ATTACHMENT_BYTES,
  MAX_DESKTOP_IMAGE_ATTACHMENT_BYTES,
} from "./collaboration-attachments.mjs";

export const DESKTOP_COLLABORATION_SCHEMA_VERSION = 1;
export const DESKTOP_COLLABORATION_FILE_NAME = "collaboration-state.json";

const MAX_MESSAGES_PER_MODE = 200;
const MAX_HANDOFF_CARDS = 100;
const MAX_QUEUE_TASKS = 50;
const MAX_ATTACHMENTS_PER_LIST = 8;
const MAX_CITATIONS_PER_MESSAGE = 12;
const MAX_LIST_ITEMS = 20;
const MAX_PLAN_STEPS = 50;
const MAX_PLAN_LIST_ITEMS = 30;
const MAX_STRING = 50_000;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_ATTACHMENT_PAYLOAD_BYTES = 32 * 1024 * 1024;
const PROVIDER_IDS = new Set([
  "demo",
  "openai",
  "anthropic",
  "qwen",
  "deepseek",
  "copilot",
  "local",
  "custom",
]);
const PROVIDER_PROTOCOLS = new Set([
  "demo",
  "openai-responses",
  "openai-chat",
  "anthropic",
]);

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label}必须是对象`);
  }
  return value;
}

function string(value, label, maxLength = MAX_STRING) {
  if (typeof value !== "string") throw new TypeError(`${label}必须是字符串`);
  if (value.length > maxLength) throw new RangeError(`${label}超过允许大小`);
  return value;
}

function boolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label}必须是布尔值`);
  return value;
}

function boundedArray(value, label, maxItems) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new RangeError(`${label}数量无效`);
  }
  return value;
}

function rejectApiKeyFields(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) rejectApiKeyFields(item, seen);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[-_.\s]/g, "");
    if (
      normalized.includes("apikey") ||
      normalized.includes("apitoken") ||
      normalized === "authorization"
    ) {
      throw new RangeError("协作状态不得包含 API 密钥字段");
    }
    rejectApiKeyFields(item, seen);
  }
}

function httpUrl(value, label, { optional = false } = {}) {
  if (optional && value === undefined) return undefined;
  const source = string(value, label, 2_048);
  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    throw new TypeError(`${label}格式不正确`);
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  ) {
    throw new RangeError(`${label}必须是无认证信息的 HTTP(S) 地址`);
  }
  for (const key of parsed.searchParams.keys()) {
    const normalized = key.toLowerCase().replace(/[-_.]/g, "");
    if (
      /^(?:key|auth|sig)$|(?:apikey|apitoken|authtoken|accesstoken|accesskey|authkey|clientsecret|credential|password|passwd|privatekey|secret|signature|token)/.test(
        normalized,
      )
    ) {
      throw new RangeError(`${label}不得包含敏感查询参数`);
    }
  }
  if (
    parsed.hash &&
    /(?:api[_-]?key|auth|password|secret|signature|token)/i.test(parsed.hash)
  ) {
    throw new RangeError(`${label}不得包含敏感片段`);
  }
  return source;
}

function normalizeCitation(value, index) {
  const citation = record(value, `引用 ${index + 1}`);
  return {
    id: string(citation.id, "引用 ID", 200),
    title: string(citation.title, "引用标题", 500),
    url: httpUrl(citation.url, "引用地址"),
    ...(citation.snippet === undefined
      ? {}
      : { snippet: string(citation.snippet, "引用摘要", 4_000) }),
  };
}

function normalizeSuggestion(value, index) {
  const suggestion = record(value, `建议 ${index + 1}`);
  return {
    label: string(suggestion.label, "建议标签", 500),
    prompt: string(suggestion.prompt, "建议提示", 8_000),
    ...(suggestion.description === undefined
      ? {}
      : {
          description: string(
            suggestion.description,
            "建议说明",
            2_000,
          ),
        }),
  };
}

function normalizeReport(value) {
  if (value === undefined) return undefined;
  const report = record(value, "Cowork 报告");
  if (!["completed", "partial", "blocked"].includes(report.status)) {
    throw new RangeError("Cowork 报告状态无效");
  }
  const textList = (items, label) =>
    boundedArray(items, label, MAX_LIST_ITEMS).map((item, index) =>
      string(item, `${label} ${index + 1}`, 4_000));
  return {
    status: report.status,
    updates: textList(report.updates, "更新"),
    issues: textList(report.issues, "问题"),
    suggestions: boundedArray(
      report.suggestions,
      "建议",
      MAX_LIST_ITEMS,
    ).map(normalizeSuggestion),
  };
}

function normalizeCoworkPlan(value) {
  const plan = record(value, "Cowork 任务计划");
  if (plan.strategy !== "mission") {
    throw new RangeError("Cowork 任务计划策略无效");
  }
  const planList = (items, label) =>
    boundedArray(items, label, MAX_PLAN_LIST_ITEMS).map((item, index) =>
      string(item, `${label} ${index + 1}`, 4_000));
  return {
    strategy: "mission",
    objective: string(plan.objective, "Cowork 任务计划目标", 10_000),
    summary: string(plan.summary, "Cowork 任务计划摘要", 10_000),
    assumptions: planList(plan.assumptions, "Cowork 任务计划假设"),
    steps: boundedArray(
      plan.steps,
      "Cowork 任务计划步骤",
      MAX_PLAN_STEPS,
    ).map((item, index) => {
      const step = record(item, `Cowork 任务计划步骤 ${index + 1}`);
      return {
        id: string(step.id, "Cowork 任务计划步骤 ID", 200),
        title: string(step.title, "Cowork 任务计划步骤标题", 500),
        description: string(
          step.description,
          "Cowork 任务计划步骤说明",
          8_000,
        ),
      };
    }),
    acceptanceCriteria: planList(
      plan.acceptanceCriteria,
      "Cowork 任务计划验收标准",
    ),
    openQuestions: planList(
      plan.openQuestions,
      "Cowork 任务计划待确认问题",
    ),
  };
}

function normalizeMessage(value, index) {
  const message = record(value, `消息 ${index + 1}`);
  if (!["assistant", "user"].includes(message.role)) {
    throw new RangeError("消息角色无效");
  }
  const queueState =
    message.queueState === "running" ? "interrupted" : message.queueState;
  if (
    queueState !== undefined &&
    !["steer", "queued", "interrupted"].includes(queueState)
  ) {
    throw new RangeError("消息队列状态无效");
  }
  if (
    message.streamState !== undefined &&
    !["streaming", "completed", "stopped"].includes(message.streamState)
  ) {
    throw new RangeError("消息流状态无效");
  }
  const phase =
    message.phase === undefined
      ? undefined
      : (() => {
          const source = record(message.phase, "消息阶段");
          return {
            stage: string(source.stage, "消息阶段", 100),
            message: string(source.message, "阶段说明", 1_000),
          };
        })();
  return {
    id: string(message.id, "消息 ID", 200),
    role: message.role,
    text: string(message.text, "消息正文"),
    ...(message.detail === undefined
      ? {}
      : { detail: string(message.detail, "消息详情", 10_000) }),
    ...(message.error === undefined
      ? {}
      : { error: boolean(message.error, "消息错误标记") }),
    ...(message.jobId === undefined
      ? {}
      : { jobId: string(message.jobId, "任务 ID", 200) }),
    ...(queueState === undefined ? {} : { queueState }),
    ...(message.report === undefined
      ? {}
      : { report: normalizeReport(message.report) }),
    ...(message.plan === undefined
      ? {}
      : { plan: normalizeCoworkPlan(message.plan) }),
    ...(message.citations === undefined
      ? {}
      : {
          citations: boundedArray(
            message.citations,
            "消息引用",
            MAX_CITATIONS_PER_MESSAGE,
          ).map(normalizeCitation),
        }),
    ...(message.streamState === undefined
      ? {}
      : {
          streamState:
            message.streamState === "streaming"
              ? "stopped"
              : message.streamState,
        }),
    ...(phase === undefined ? {} : { phase }),
    ...(message.handoffCardId === undefined
      ? {}
      : {
          handoffCardId: string(
            message.handoffCardId,
            "任务卡 ID",
            200,
          ),
        }),
  };
}

function normalizeAttachment(value, index) {
  const attachment = record(value, `附件 ${index + 1}`);
  if (!["image", "document"].includes(attachment.kind)) {
    throw new RangeError("附件类型无效");
  }
  const id = string(attachment.id, "附件 ID", 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(id)) {
    throw new RangeError("附件 ID 无效");
  }
  const mimeType = string(attachment.mimeType, "附件 MIME 类型", 200);
  if (
    (attachment.kind === "image" &&
      !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
        mimeType,
      )) ||
    (attachment.kind === "document" &&
      !/^text\/[a-z0-9.+-]+$/.test(mimeType) &&
      ![
        "application/json",
        "application/javascript",
        "application/xml",
        "application/xhtml+xml",
      ].includes(mimeType))
  ) {
    throw new RangeError("附件 MIME 类型无效");
  }
  const maximumSize =
    attachment.kind === "image"
      ? MAX_DESKTOP_IMAGE_ATTACHMENT_BYTES
      : MAX_DESKTOP_DOCUMENT_ATTACHMENT_BYTES;
  if (
    (!Number.isSafeInteger(attachment.sizeBytes) ||
      attachment.sizeBytes < 0 ||
      attachment.sizeBytes > maximumSize)
  ) {
    throw new RangeError("附件大小无效");
  }
  if (!isCollaborationAttachmentReference(attachment.reference)) {
    throw new RangeError("附件缺少有效的持久化引用");
  }
  return {
    id,
    name: string(attachment.name, "附件名称", 500),
    mimeType,
    kind: attachment.kind,
    sizeBytes: attachment.sizeBytes,
    ...(attachment.sizeLabel === undefined
      ? {}
      : {
          sizeLabel: string(attachment.sizeLabel, "附件大小标签", 100),
        }),
    reference: attachment.reference,
  };
}

function normalizeAttachmentList(value, label) {
  return boundedArray(value, label, MAX_ATTACHMENTS_PER_LIST).map(
    normalizeAttachment,
  );
}

function normalizeModelConfig(value, label) {
  const config = record(value, label);
  const providerId = string(config.providerId, "模型服务", 50);
  const protocol = string(config.protocol, "请求协议", 50);
  if (!PROVIDER_IDS.has(providerId)) throw new RangeError("模型服务不受支持");
  if (!PROVIDER_PROTOCOLS.has(protocol)) {
    throw new RangeError("请求协议不受支持");
  }
  const baseUrl =
    config.baseUrl === ""
      ? ""
      : httpUrl(config.baseUrl, "模型节点地址");
  return {
    providerId,
    protocol,
    baseUrl,
    model: string(config.model, "模型名称", 200),
  };
}

function normalizeRect(value, label) {
  const source = record(value, label);
  const result = {};
  for (const key of ["x", "y", "width", "height"]) {
    if (!Number.isFinite(source[key]) || Math.abs(source[key]) > 10_000_000) {
      throw new RangeError(`${label}${key}无效`);
    }
    result[key] = source[key];
  }
  return result;
}

function normalizeSelection(value) {
  if (value === null || value === undefined) return null;
  const selection = record(value, "选区");
  if (!["element", "region", "drawing"].includes(selection.type)) {
    throw new RangeError("选区类型无效");
  }
  const targets =
    selection.targets === undefined
      ? undefined
      : boundedArray(selection.targets, "选区目标", 20).map(
          (item, index) => {
            const target = record(item, `选区目标 ${index + 1}`);
            return {
              label: string(target.label, "选区目标标签", 500),
              selector: string(target.selector, "选区目标选择器", 2_000),
              html: string(target.html, "选区目标 HTML", 200_000),
              rect: normalizeRect(target.rect, "选区目标矩形"),
            };
          },
        );
  const anchors =
    selection.anchors === undefined
      ? undefined
      : boundedArray(selection.anchors, "选区锚点", 20).map((anchor) =>
          string(anchor, "选区锚点", 500));
  const placement =
    selection.placement === undefined
      ? undefined
      : (() => {
          const source = record(selection.placement, "选区放置点");
          if (!["prepend", "between", "append"].includes(source.relation)) {
            throw new RangeError("选区放置关系无效");
          }
          if (!["horizontal", "vertical"].includes(source.axis)) {
            throw new RangeError("选区放置轴无效");
          }
          for (const key of ["xPercent", "yPercent"]) {
            if (!Number.isFinite(source[key]) || Math.abs(source[key]) > 1_000) {
              throw new RangeError(`选区放置点 ${key} 无效`);
            }
          }
          if (
            source.childIndex !== undefined &&
            (!Number.isSafeInteger(source.childIndex) ||
              source.childIndex < 0 ||
              source.childIndex > 100_000)
          ) {
            throw new RangeError("选区子元素索引无效");
          }
          const parentPath =
            source.parentPath === undefined
              ? undefined
              : boundedArray(source.parentPath, "选区父路径", 100).map(
                  (part) => {
                    if (
                      !Number.isSafeInteger(part) ||
                      part < 0 ||
                      part > 100_000
                    ) {
                      throw new RangeError("选区父路径无效");
                    }
                    return part;
                  },
                );
          const optionalSelector = (key, label, maxLength = 2_000) =>
            source[key] === undefined
              ? {}
              : { [key]: string(source[key], label, maxLength) };
          return {
            relation: source.relation,
            axis: source.axis,
            parentSelector: string(
              source.parentSelector,
              "选区父选择器",
              2_000,
            ),
            ...optionalSelector("previousSelector", "选区前一选择器"),
            ...optionalSelector("nextSelector", "选区后一选择器"),
            xPercent: source.xPercent,
            yPercent: source.yPercent,
            ...(parentPath === undefined ? {} : { parentPath }),
            ...(source.childIndex === undefined
              ? {}
              : { childIndex: source.childIndex }),
            ...optionalSelector("parentAnchor", "选区父锚点", 500),
            ...optionalSelector("previousAnchor", "选区前一锚点", 500),
            ...optionalSelector("nextAnchor", "选区后一锚点", 500),
            ...optionalSelector("slotAnchor", "选区插槽锚点", 500),
          };
        })();
  return {
    type: selection.type,
    label: string(selection.label, "选区标签", 500),
    ...(selection.selector === undefined
      ? {}
      : { selector: string(selection.selector, "选区选择器", 2_000) }),
    ...(selection.html === undefined
      ? {}
      : { html: string(selection.html, "选区 HTML", 500_000) }),
    ...(targets === undefined ? {} : { targets }),
    ...(anchors === undefined ? {} : { anchors }),
    ...(placement === undefined ? {} : { placement }),
    rect: normalizeRect(selection.rect, "选区矩形"),
  };
}

function normalizeTask(value, index, restoreState) {
  const task = record(value, `队列任务 ${index + 1}`);
  if (task.mode !== "cowork") throw new RangeError("队列只允许 Cowork 任务");
  if (!["normal", "steer", "queued"].includes(task.priority)) {
    throw new RangeError("队列任务优先级无效");
  }
  const strategy = task.strategy === undefined ? "auto" : task.strategy;
  if (!["auto", "direct", "mission"].includes(strategy)) {
    throw new RangeError("Cowork 任务策略无效");
  }
  const interactionMode =
    task.interactionMode === undefined
      ? "auto"
      : task.interactionMode;
  if (!["auto", "plan", "agent"].includes(interactionMode)) {
    throw new RangeError("统一协作模式无效");
  }
  return {
    id: string(task.id, "任务 ID", 200),
    messageId: string(task.messageId, "任务消息 ID", 200),
    mode: "cowork",
    instruction: string(task.instruction, "任务指令", 50_000),
    attachments: normalizeAttachmentList(task.attachments, "任务附件"),
    selection: normalizeSelection(task.selection),
    priority: task.priority,
    interactionMode,
    strategy,
    modelConfig: normalizeModelConfig(
      task.modelConfig ?? task.config,
      "任务模型配置",
    ),
    ...(task.handoffCardId === undefined
      ? {}
      : {
          handoffCardId: string(task.handoffCardId, "任务卡 ID", 200),
        }),
    restoreState,
  };
}

function normalizeHandoffCard(value, index) {
  const card = record(value, `任务卡 ${index + 1}`);
  const list = (items, label) =>
    boundedArray(items, label, MAX_LIST_ITEMS).map((item, itemIndex) =>
      string(item, `${label} ${itemIndex + 1}`, 4_000));
  return {
    id: string(card.id, "任务卡 ID", 200),
    title: string(card.title, "任务卡标题", 500),
    objective: string(card.objective, "任务卡目标", 10_000),
    decisions: list(card.decisions, "任务卡决策"),
    references: boundedArray(
      card.references,
      "任务卡参考资料",
      MAX_LIST_ITEMS,
    ).map((item, referenceIndex) => {
      const reference = record(item, `参考资料 ${referenceIndex + 1}`);
      return {
        title: string(reference.title, "参考资料标题", 500),
        ...(reference.url === undefined
          ? {}
          : { url: httpUrl(reference.url, "参考资料地址") }),
        note: string(reference.note, "参考资料说明", 4_000),
      };
    }),
    constraints: list(card.constraints, "任务卡约束"),
    openQuestions: list(card.openQuestions, "任务卡待解决问题"),
    instruction: string(card.instruction, "任务卡指令", 50_000),
    sourceMessageIds: boundedArray(
      card.sourceMessageIds,
      "任务卡源消息",
      MAX_LIST_ITEMS,
    ).map((id) => string(id, "源消息 ID", 200)),
    createdAt: string(card.createdAt, "任务卡创建时间", 100),
  };
}

function normalizePaneState(value) {
  const panes = record(value, "协作面板状态");
  const pane = (source, label, defaultWidth) => {
    const item = record(source, label);
    const width = Number(item.width);
    if (!Number.isFinite(width) || width < 240 || width > 900) {
      throw new RangeError(`${label}宽度无效`);
    }
    return {
      open: boolean(item.open, `${label}打开状态`),
      width: Math.round(width || defaultWidth),
    };
  };
  if (!["canvas", "cowork", "chat"].includes(panes.activeMobilePane)) {
    throw new RangeError("移动端活动面板无效");
  }
  const layout = panes.layout === undefined ? "parallel" : panes.layout;
  if (!["parallel", "switch"].includes(layout)) {
    throw new RangeError("协作布局无效");
  }
  return {
    cowork: pane(panes.cowork, "Cowork 面板", 390),
    chat: pane(panes.chat, "Chat 面板", 360),
    activeMobilePane: panes.activeMobilePane,
    layout,
  };
}

export function normalizeCollaborationState(value) {
  rejectApiKeyFields(value);
  const state = record(value, "协作状态");
  const inputSource = JSON.stringify(value);
  if (Buffer.byteLength(inputSource, "utf8") > MAX_TOTAL_BYTES * 2) {
    throw new RangeError("协作状态输入大小超过 8 MB");
  }
  if (state.schemaVersion !== DESKTOP_COLLABORATION_SCHEMA_VERSION) {
    throw new RangeError("协作状态版本不受支持");
  }
  const legacyCoworkMessages = boundedArray(
    state.coworkMessages ?? [],
    "Cowork 消息",
    MAX_MESSAGES_PER_MODE,
  ).map(normalizeMessage);
  const legacyChatMessages = boundedArray(
    state.chatMessages ?? [],
    "Chat 消息",
    MAX_MESSAGES_PER_MODE,
  ).map(normalizeMessage);
  const unifiedMessages =
    state.unifiedMessages === undefined
      ? (() => {
          if (!legacyCoworkMessages.length) {
            return legacyChatMessages.slice(-MAX_MESSAGES_PER_MODE);
          }
          if (!legacyChatMessages.length) {
            return legacyCoworkMessages.slice(-MAX_MESSAGES_PER_MODE);
          }
          const coworkShare = Math.ceil(MAX_MESSAGES_PER_MODE / 2);
          const chatShare = MAX_MESSAGES_PER_MODE - coworkShare;
          return [
            ...legacyCoworkMessages.slice(-coworkShare),
            ...legacyChatMessages.slice(-chatShare),
          ];
        })()
      : boundedArray(
          state.unifiedMessages,
          "统一协作消息",
          MAX_MESSAGES_PER_MODE,
        ).map(normalizeMessage);
  const activeMode = state.activeMode ?? "auto";
  if (!["auto", "plan", "agent"].includes(activeMode)) {
    throw new RangeError("统一协作活动模式无效");
  }
  const coworkStrategy =
    state.coworkStrategy === undefined ? "auto" : state.coworkStrategy;
  if (!["auto", "direct", "mission"].includes(coworkStrategy)) {
    throw new RangeError("Cowork 策略无效");
  }
  const queued = boundedArray(
    state.coworkQueue,
    "Cowork 队列",
    MAX_QUEUE_TASKS,
  ).map((task, index) =>
    normalizeTask(
      task,
      index,
      task?.restoreState === "interrupted" ? "interrupted" : "paused",
    ));
  if (state.activeCoworkTask !== null && state.activeCoworkTask !== undefined) {
    if (queued.length >= MAX_QUEUE_TASKS) {
      throw new RangeError("Cowork 队列数量无效");
    }
    queued.unshift(normalizeTask(state.activeCoworkTask, 0, "interrupted"));
  }
  const attachments =
    state.attachments === undefined
      ? { cowork: [], chat: [] }
      : record(state.attachments, "待发送附件");
  const legacyPanes =
    state.panes === undefined
      ? {
          layout: "switch",
          cowork: { open: true, width: 390 },
          chat: { open: false, width: 360 },
          activeMobilePane: "cowork",
        }
      : normalizePaneState(state.panes);
  const paneSource =
    state.pane === undefined
      ? {
          open:
            legacyPanes.cowork.open || legacyPanes.chat.open,
          width: legacyPanes.cowork.width,
        }
      : record(state.pane, "统一协作侧栏");
  const paneWidth = Number(paneSource.width);
  if (
    typeof paneSource.open !== "boolean" ||
    !Number.isFinite(paneWidth) ||
    paneWidth < 240 ||
    paneWidth > 900
  ) {
    throw new RangeError("统一协作侧栏状态无效");
  }
  const pendingAttachments =
    state.pendingAttachments === undefined
      ? [
          ...normalizeAttachmentList(
            attachments.cowork,
            "Cowork 待发送附件",
          ),
          ...normalizeAttachmentList(
            attachments.chat,
            "Chat 待发送附件",
          ),
        ].slice(0, MAX_ATTACHMENTS_PER_LIST)
      : normalizeAttachmentList(
          state.pendingAttachments,
          "统一待发送附件",
        );
  const normalized = {
    schemaVersion: DESKTOP_COLLABORATION_SCHEMA_VERSION,
    unifiedMessages,
    activeMode,
    pane: {
      open: paneSource.open,
      width: Math.round(paneWidth),
    },
    pendingAttachments,
    coworkMessages: legacyCoworkMessages,
    chatMessages: legacyChatMessages,
    handoffCards: boundedArray(
      state.handoffCards,
      "任务卡",
      MAX_HANDOFF_CARDS,
    ).map(normalizeHandoffCard),
    coworkQueue: queued,
    coworkQueuePaused:
      boolean(state.coworkQueuePaused, "Cowork 队列暂停状态") ||
      queued.length > 0,
    activeCoworkTask: null,
    coworkStrategy,
    panes: legacyPanes,
    chatModelOverride:
      state.chatModelOverride === null ||
      state.chatModelOverride === undefined
        ? null
        : normalizeModelConfig(state.chatModelOverride, "Chat 模型覆盖配置"),
    attachments: {
      cowork: normalizeAttachmentList(attachments.cowork, "Cowork 待发送附件"),
      chat: normalizeAttachmentList(attachments.chat, "Chat 待发送附件"),
    },
    savedAt:
      typeof state.savedAt === "string"
        ? string(state.savedAt, "协作状态保存时间", 100)
        : new Date().toISOString(),
  };
  const attachmentBytes = new Map();
  for (const attachment of [
    ...pendingAttachments,
    ...queued.flatMap((task) => task.attachments),
  ]) {
    attachmentBytes.set(attachment.reference, attachment.sizeBytes);
  }
  const totalAttachmentBytes = [...attachmentBytes.values()].reduce(
    (total, size) => total + size,
    0,
  );
  if (totalAttachmentBytes > MAX_ATTACHMENT_PAYLOAD_BYTES) {
    throw new RangeError("持久化附件总大小超过 32 MB");
  }
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_TOTAL_BYTES) {
    throw new RangeError("协作状态总大小超过 4 MB");
  }
  return normalized;
}

function replaceFileSync(tempPath, destinationPath) {
  const rollbackPath = `${destinationPath}.rollback`;
  try {
    renameSync(tempPath, destinationPath);
  } catch (error) {
    if (
      process.platform !== "win32" ||
      !error ||
      typeof error !== "object" ||
      !["EEXIST", "EPERM"].includes(error.code)
    ) {
      throw error;
    }
    rmSync(rollbackPath, { force: true });
    try {
      renameSync(destinationPath, rollbackPath);
    } catch (backupError) {
      if (
        backupError &&
        typeof backupError === "object" &&
        backupError.code === "ENOENT"
      ) {
        renameSync(tempPath, destinationPath);
        return;
      }
      throw new AggregateError(
        [error, backupError],
        "无法为现有协作状态创建回滚副本",
      );
    }
    try {
      renameSync(tempPath, destinationPath);
    } catch (replacementError) {
      try {
        renameSync(rollbackPath, destinationPath);
      } catch (recoveryError) {
        throw new AggregateError(
          [replacementError, recoveryError],
          `协作状态替换失败，回滚副本保留在 ${rollbackPath}`,
        );
      }
      throw replacementError;
    }
  }
  rmSync(rollbackPath, { force: true });
}

export async function readCollaborationState(filePath) {
  let source;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      try {
        await rename(`${filePath}.rollback`, filePath);
        source = await readFile(filePath, "utf8");
      } catch (rollbackError) {
        if (
          rollbackError &&
          typeof rollbackError === "object" &&
          rollbackError.code === "ENOENT"
        ) {
          try {
            source = await readFile(filePath, "utf8");
          } catch (retryError) {
            if (
              retryError &&
              typeof retryError === "object" &&
              retryError.code === "ENOENT"
            ) {
              return null;
            }
            throw retryError;
          }
        } else {
          throw rollbackError;
        }
      }
    } else {
      throw error;
    }
  }
  if (Buffer.byteLength(source, "utf8") > MAX_TOTAL_BYTES * 2) {
    throw new RangeError("协作状态文件大小超过 8 MB");
  }
  return normalizeCollaborationState(JSON.parse(source));
}

export async function quarantineCollaborationState(
  filePath,
  timestamp = Date.now(),
) {
  const parsed = path.parse(filePath);
  const backupPath = path.join(
    parsed.dir,
    `${parsed.name}.corrupt-${timestamp}${parsed.ext}`,
  );
  await rename(filePath, backupPath);
  return backupPath;
}

export async function writeCollaborationState(filePath, value, { shouldCommit } = {}) {
  const normalized = normalizeCollaborationState(value);
  const directory = path.dirname(filePath);
  const tempPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(tempPath, `${JSON.stringify(normalized)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    if (shouldCommit && !shouldCommit()) return false;
    replaceFileSync(tempPath, filePath);
    return true;
  } finally {
    await rm(tempPath, { force: true });
  }
}

export function writeCollaborationStateSync(filePath, value) {
  const normalized = normalizeCollaborationState(value);
  const directory = path.dirname(filePath);
  const tempPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(tempPath, `${JSON.stringify(normalized)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    replaceFileSync(tempPath, filePath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}
