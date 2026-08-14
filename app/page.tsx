"use client";

import {
  ArrowRight,
  BoxSelect,
  Check,
  ChevronDown,
  CircleAlert,
  Code2,
  Copy,
  Download,
  FilePlus2,
  FileText,
  FolderOpen,
  Hand,
  Image as ImageIcon,
  ImagePlus,
  Loader2,
  Maximize2,
  MessageSquare,
  Minus,
  Monitor,
  MousePointer2,
  Move,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Pencil,
  Plus,
  Redo2,
  RotateCcw,
  Send,
  Settings2,
  Smartphone,
  Sparkles,
  Tablet,
  Trash2,
  Undo2,
  Wand2,
  X,
  ListPlus,
  Route,
  RefreshCw,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  BLANK_HTML,
  PROMPT_SUGGESTIONS,
  PROVIDERS,
  STARTER_HTML,
  type ProviderId,
  type ProviderProtocol,
} from "./editor-data";
import {
  desktopErrorMessage,
  formatDesktopBytes,
  type DesktopInfo,
  type DesktopProjectSnapshot,
  type DesktopUpdateState,
} from "./desktop-api";

type ToolMode = "interact" | "select" | "move" | "region" | "draw";
type DeviceMode = "desktop" | "tablet" | "mobile";
type PanelTab = "chat" | "code";
type CollaborationMode = "cowork" | "chat";

type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type Point = { x: number; y: number };

type SelectionTarget = {
  label: string;
  selector: string;
  html: string;
  rect: Rect;
};

type SelectionPlacement = {
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

type SelectionContext = {
  type: "element" | "region" | "drawing";
  label: string;
  selector?: string;
  html?: string;
  targets?: SelectionTarget[];
  anchors?: string[];
  placement?: SelectionPlacement;
  rect: Rect;
};

type PendingFreeMove = {
  selector: string;
  label: string;
  x: number;
  y: number;
  originalTranslate: string;
  originalX: string;
  originalY: string;
  originalOutline: string;
  originalOutlineOffset: string;
};

type FreeMoveDrag = PendingFreeMove & {
  startX: number;
  startY: number;
  beforeX: number;
  beforeY: number;
  wasStaged: boolean;
  element: HTMLElement;
};

type FreeMoveStep = {
  selector: string;
  beforeX: number;
  beforeY: number;
  afterX: number;
  afterY: number;
};

type Attachment = {
  id: string;
  name: string;
  mimeType: string;
  kind: "image" | "document";
  data?: string;
  text?: string;
  sizeLabel: string;
};

type CoworkStatus = "completed" | "partial" | "blocked";

type CoworkSuggestion = {
  label: string;
  prompt: string;
  description?: string;
};

type CoworkReport = {
  status: CoworkStatus;
  updates: string[];
  issues: string[];
  suggestions: CoworkSuggestion[];
};

type CoworkResult = CoworkReport & {
  html: string;
  summary: string;
  insertionApplied?: boolean;
};

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  detail?: string;
  error?: boolean;
  jobId?: string;
  queueState?: "steer" | "queued" | "running";
  report?: CoworkReport;
};

type AgentJobPriority = "normal" | "steer" | "queued";

type AgentJob = {
  id: string;
  messageId: string;
  mode: CollaborationMode;
  instruction: string;
  attachments: Attachment[];
  selection: SelectionContext | null;
  priority: AgentJobPriority;
  config: ModelConfig;
};

type ModelConfig = {
  providerId: ProviderId;
  protocol: ProviderProtocol;
  baseUrl: string;
  model: string;
  apiKey: string;
};

type ProjectReplacement = {
  html: string;
  name: string;
  detail: string;
  toast: string;
};

const DEVICE_SIZES: Record<DeviceMode, { width: number; height: number }> = {
  desktop: { width: 980, height: 690 },
  tablet: { width: 768, height: 720 },
  mobile: { width: 390, height: 720 },
};

const MIN_CANVAS_SCALE = 0.15;
const MAX_CANVAS_SCALE = 2.5;
const CANVAS_WHEEL_ZOOM_SENSITIVITY = 0.0015;

function clampCanvasScale(scale: number) {
  return Math.min(MAX_CANVAS_SCALE, Math.max(MIN_CANVAS_SCALE, scale));
}

const INITIAL_COWORK_MESSAGES: ChatMessage[] = [
  {
    id: "cowork-welcome",
    role: "assistant",
    text: "画布已经就绪。下一步想让它变成什么样？",
    detail: "当前模型 · Canvasly Demo",
  },
];

const INITIAL_CHAT_MESSAGES: ChatMessage[] = [
  {
    id: "chat-welcome",
    role: "assistant",
    text: "我们可以先聊清楚方向、内容和取舍。Chat 模式不会修改画布。",
    detail: "对话建议 · 当前页面作为上下文",
  },
];

const CHAT_SUGGESTIONS = [
  "这个页面目前最需要改进什么？",
  "帮我梳理信息层级",
  "这个视觉方向适合什么用户？",
  "给我三个可选的优化方向",
];

function failureReport(message: string, instruction: string): CoworkReport {
  const retry = {
    label: "重试原任务",
    description: "保留当前画布，再执行一次相同要求。",
    prompt: instruction,
  };
  const narrowScope = {
    label: "缩小修改范围",
    description: "先完成一个最明确的局部改动，降低生成复杂度。",
    prompt: `请把下面任务拆成一步，只完成其中最明确、最局部的修改：\n${instruction}`,
  };
  const chooseTarget = {
    label: "重新选择目标",
    description: "先在画布中选择具体容器或元素，再运行这条要求。",
    prompt: instruction,
  };

  return {
    status: "blocked",
    updates: [],
    issues: [message],
    suggestions:
      /位置|边界|容器|圈选/.test(message)
        ? [chooseTarget, narrowScope]
        : /超时|timeout/i.test(message)
          ? [retry, narrowScope]
          : [retry, narrowScope],
  };
}

const initialProvider = PROVIDERS[0];
const EDIT_TARGET_ATTRIBUTE = "data-canvasly-edit-target";
const PLACEMENT_ANCHOR_ATTRIBUTE = "data-canvasly-placement-anchor";
const INSERTION_SLOT_ATTRIBUTE = "data-canvasly-insertion-slot";

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function prettyBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function projectNameFromFile(fileName: string) {
  return fileName.replace(/\.(?:html?|xhtml)$/i, "").trim() || "未命名页面";
}

function exportFileName(projectName: string) {
  const safeName = projectName.trim().replace(/[\\/:*?"<>|]+/g, "-");
  return `${safeName || "canvasly-page"}.html`;
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("文件读取失败"));
    reader.readAsText(file);
  });
}

function safePreviewHtml(source: string) {
  const cspContent = "default-src 'none'; script-src 'none'; img-src data: https:; style-src 'unsafe-inline'; font-src data:; media-src data: https:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';";
  const previewStyleContent = "html{height:100%!important;overflow:hidden!important}body{height:100%!important;overflow:auto!important;scroll-behavior:auto!important}";
  const fallback = source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, "");
  const csp = `<meta http-equiv="Content-Security-Policy" content="${cspContent}">`;
  const previewStyle = `<style data-canvasly-preview>${previewStyleContent}</style>`;
  if (typeof DOMParser === "undefined") {
    if (/<head\b[^>]*>/i.test(fallback)) {
      return fallback.replace(/<head\b[^>]*>/i, (head) => `${head}${csp}${previewStyle}`);
    }
    return `<head>${csp}${previewStyle}</head>${fallback}`;
  }

  const doc = new DOMParser().parseFromString(fallback, "text/html");
  doc.querySelectorAll("script, iframe, object, embed, base").forEach((element) => element.remove());
  doc.querySelectorAll("meta[http-equiv]").forEach((element) => {
    const directive = element.getAttribute("http-equiv")?.toLowerCase();
    if (directive === "refresh" || directive === "content-security-policy") {
      element.remove();
    }
  });
  doc.querySelectorAll("*").forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (
        name.startsWith("on") ||
        name === "srcdoc" ||
        (["href", "src", "action", "formaction", "xlink:href"].includes(name) &&
          /^javascript:/i.test(value))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  });
  const policy = doc.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = cspContent;
  doc.head.prepend(policy);
  const previewStyles = doc.createElement("style");
  previewStyles.setAttribute("data-canvasly-preview", "");
  previewStyles.textContent = previewStyleContent;
  doc.head.append(previewStyles);
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

function getElementLabel(element: Element) {
  const text = element.textContent?.replace(/\s+/g, " ").trim();
  const role = element.getAttribute("aria-label");
  const tag = element.tagName.toLowerCase();
  if (role) return role;
  if (text) return `${tag} · ${text.slice(0, 42)}${text.length > 42 ? "…" : ""}`;
  if (element.id) return `${tag}#${element.id}`;
  const firstClass = element.classList.item(0);
  return firstClass ? `${tag}.${firstClass}` : tag;
}

function cssEscape(value: string) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function getUniqueSelector(element: Element) {
  if (element.id) return `#${cssEscape(element.id)}`;
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current.tagName.toLowerCase() !== "html") {
    const tag = current.tagName.toLowerCase();
    const parent: Element | null = current.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const siblings = Array.from(parent.children).filter(
      (sibling) => sibling.tagName === current?.tagName,
    );
    const index = siblings.indexOf(current) + 1;
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag);
    if (tag === "body") break;
    current = parent;
  }
  return parts.join(" > ");
}

function rectFromPoints(points: Point[]): Rect {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(24, Math.max(...xs) - minX),
    height: Math.max(24, Math.max(...ys) - minY),
  };
}

function intersectionArea(first: Rect, second: Rect) {
  const width = Math.max(
    0,
    Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x),
  );
  const height = Math.max(
    0,
    Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y),
  );
  return width * height;
}

function getSelectionTargets(doc: Document, rect: Rect) {
  const regionArea = Math.max(1, rect.width * rect.height);
  return Array.from(doc.body.querySelectorAll<HTMLElement>("*"))
    .filter((element) => !["SCRIPT", "STYLE", "TEMPLATE"].includes(element.tagName))
    .map((element) => {
      const bounds = element.getBoundingClientRect();
      const elementRect = {
        x: bounds.left,
        y: bounds.top,
        width: bounds.width,
        height: bounds.height,
      };
      const overlap = intersectionArea(rect, elementRect);
      const elementArea = Math.max(1, bounds.width * bounds.height);
      const unionArea = regionArea + elementArea - overlap;
      return {
        element,
        rect: elementRect,
        overlap,
        score: overlap / Math.max(1, unionArea) + overlap / regionArea,
      };
    })
    .filter(({ overlap, rect: elementRect }) => overlap > 0 && elementRect.width > 1 && elementRect.height > 1)
    .sort((first, second) => second.score - first.score)
    .slice(0, 6)
    .map(({ element, rect: elementRect }) => ({
      label: getElementLabel(element),
      selector: getUniqueSelector(element),
      html: element.outerHTML.slice(0, 1600),
      rect: elementRect,
    }));
}

const COMPONENT_CONTAINER_TAGS = new Set([
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "BODY",
  "DIALOG",
  "DIV",
  "FOOTER",
  "FORM",
  "HEADER",
  "LI",
  "MAIN",
  "NAV",
  "SECTION",
  "TD",
  "TH",
]);
const RESTRICTIVE_CONTAINER_TAGS = new Set([
  "COLGROUP",
  "DL",
  "OL",
  "OPTGROUP",
  "SELECT",
  "TABLE",
  "TBODY",
  "TFOOT",
  "THEAD",
  "TR",
  "UL",
]);

function canContainComponent(element: HTMLElement) {
  return COMPONENT_CONTAINER_TAGS.has(element.tagName);
}

function rectCenter(rect: DOMRect) {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function distanceBetween(first: Point, second: Point) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function boundaryPoint(
  previous: DOMRect | undefined,
  next: DOMRect | undefined,
  axis: "horizontal" | "vertical",
) {
  if (previous && next) {
    if (axis === "horizontal") {
      return {
        x: (previous.right + next.left) / 2,
        y: (rectCenter(previous).y + rectCenter(next).y) / 2,
      };
    }
    return {
      x: (rectCenter(previous).x + rectCenter(next).x) / 2,
      y: (previous.bottom + next.top) / 2,
    };
  }
  const rect = previous ?? next;
  if (!rect) return { x: 0, y: 0 };
  if (axis === "horizontal") {
    return { x: previous ? rect.right : rect.left, y: rectCenter(rect).y };
  }
  return { x: rectCenter(rect).x, y: previous ? rect.bottom : rect.top };
}

function placementForBoundary(
  parent: HTMLElement,
  boundaryIndex: number,
  axis: "horizontal" | "vertical",
  point: Point,
): SelectionPlacement {
  const children = Array.from(parent.children);
  const previous = boundaryIndex > 0 ? children[boundaryIndex - 1] : undefined;
  const next = boundaryIndex < children.length ? children[boundaryIndex] : undefined;
  const parentRect = parent.getBoundingClientRect();
  return {
    relation: previous && next ? "between" : previous ? "append" : "prepend",
    axis,
    parentSelector: getUniqueSelector(parent),
    previousSelector: previous ? getUniqueSelector(previous) : undefined,
    nextSelector: next ? getUniqueSelector(next) : undefined,
    xPercent: Number((((point.x - parentRect.left) / Math.max(1, parentRect.width)) * 100).toFixed(1)),
    yPercent: Number((((point.y - parentRect.top) / Math.max(1, parentRect.height)) * 100).toFixed(1)),
  };
}

function getSelectionPlacement(doc: Document, rect: Rect): SelectionPlacement | undefined {
  const viewportWidth = Math.max(1, doc.documentElement.clientWidth);
  const viewportHeight = Math.max(1, doc.documentElement.clientHeight);
  const centerX = Math.min(viewportWidth - 1, Math.max(0, rect.x + rect.width / 2));
  const centerY = Math.min(viewportHeight - 1, Math.max(0, rect.y + rect.height / 2));
  const hit = doc.elementFromPoint(centerX, centerY);
  const HTMLElementCtor = doc.defaultView?.HTMLElement;
  if (!HTMLElementCtor) return undefined;
  let candidate: Element | null = hit;

  while (candidate && (!(candidate instanceof HTMLElementCtor) || !canContainComponent(candidate))) {
    if (candidate instanceof HTMLElementCtor && RESTRICTIVE_CONTAINER_TAGS.has(candidate.tagName)) {
      return undefined;
    }
    candidate = candidate.parentElement;
  }
  if (!(candidate instanceof HTMLElementCtor)) return undefined;
  const parent = candidate;

  const children = Array.from(parent.children);
  const visibleChildren = children.flatMap((child, domIndex) => {
    const bounds = child.getBoundingClientRect();
    const childStyle = doc.defaultView?.getComputedStyle(child);
    if (
      bounds.width <= 1 ||
      bounds.height <= 1 ||
      childStyle?.display === "none" ||
      childStyle?.visibility === "hidden" ||
      childStyle?.position === "absolute" ||
      childStyle?.position === "fixed"
    ) {
      return [];
    }
    return [{ child, domIndex, bounds, style: childStyle }];
  });
  const point = { x: centerX, y: centerY };
  const parentRect = parent.getBoundingClientRect();
  const style = doc.defaultView?.getComputedStyle(parent);
  const display = style?.display ?? "block";
  if (
    display.includes("flex") &&
    visibleChildren.length > 1 &&
    (style?.flexWrap !== "nowrap" || style.flexDirection.endsWith("reverse"))
  ) {
    return undefined;
  }
  if (
    (display.includes("flex") || display.includes("grid")) &&
    visibleChildren.some(({ style: childStyle }) => Number(childStyle?.order ?? "0") !== 0)
  ) {
    return undefined;
  }
  if (
    (display.includes("flex") || display.includes("grid")) &&
    style?.direction === "rtl"
  ) {
    return undefined;
  }
  if (
    display.includes("grid") &&
    (style?.gridAutoFlow.includes("dense") ||
      visibleChildren.some(({ style: childStyle }) =>
        [
          childStyle?.gridColumnStart,
          childStyle?.gridColumnEnd,
          childStyle?.gridRowStart,
          childStyle?.gridRowEnd,
        ].some((value) => value && value !== "auto"),
      ))
  ) {
    return undefined;
  }
  const axis =
    display.includes("flex") && style?.flexDirection.startsWith("row")
      ? "horizontal"
      : display.includes("grid") && visibleChildren.length > 1
        ? (() => {
            const centers = visibleChildren.map(({ bounds }) => rectCenter(bounds));
            const xSpread = Math.max(...centers.map(({ x }) => x)) - Math.min(...centers.map(({ x }) => x));
            const ySpread = Math.max(...centers.map(({ y }) => y)) - Math.min(...centers.map(({ y }) => y));
            return xSpread > ySpread ? "horizontal" : "vertical";
          })()
        : "vertical";
  if (display.includes("grid") && visibleChildren.length > 1) {
    const centers = visibleChildren.map(({ bounds }) => rectCenter(bounds));
    const columns = new Set(centers.map(({ x }) => Math.round(x / 4))).size;
    const rows = new Set(centers.map(({ y }) => Math.round(y / 4))).size;
    if (columns > 1 && rows > 1) return undefined;
  }
  if (!visibleChildren.length) {
    return placementForBoundary(parent, children.length, axis, point);
  }

  const boundaries = [
    {
      index: visibleChildren[0].domIndex,
      point: boundaryPoint(undefined, visibleChildren[0].bounds, axis),
    },
    ...visibleChildren.slice(1).map((next, index) => ({
      index: next.domIndex,
      point: boundaryPoint(visibleChildren[index].bounds, next.bounds, axis),
    })),
    {
      index: visibleChildren[visibleChildren.length - 1].domIndex + 1,
      point: boundaryPoint(visibleChildren[visibleChildren.length - 1].bounds, undefined, axis),
    },
  ];
  const boundary = boundaries.reduce((closest, current) =>
    distanceBetween(current.point, point) < distanceBetween(closest.point, point)
      ? current
      : closest,
  );
  return placementForBoundary(parent, boundary.index, axis, {
    x: Math.min(parentRect.right, Math.max(parentRect.left, centerX)),
    y: Math.min(parentRect.bottom, Math.max(parentRect.top, centerY)),
  });
}

function getElementPlacement(doc: Document, element: Element): SelectionPlacement | undefined {
  const HTMLElementCtor = doc.defaultView?.HTMLElement;
  if (!HTMLElementCtor) return undefined;
  if (element instanceof HTMLElementCtor && canContainComponent(element)) {
    const rect = element.getBoundingClientRect();
    return placementForBoundary(
      element,
      element.children.length,
      "vertical",
      { x: rect.left + rect.width / 2, y: rect.bottom },
    );
  }

  let directChild: Element = element;
  let parent = element.parentElement;
  while (parent && !canContainComponent(parent)) {
    directChild = parent;
    parent = parent.parentElement;
  }
  if (!parent) return undefined;
  const index = Array.from(parent.children).indexOf(directChild);
  if (index < 0) return undefined;
  const rect = directChild.getBoundingClientRect();
  return placementForBoundary(
    parent,
    index + 1,
    "vertical",
    { x: rect.left + rect.width / 2, y: rect.bottom },
  );
}

function setElementFreeMovePosition(element: HTMLElement, x: number, y: number) {
  element.style.setProperty("--canvasly-move-x", `${x.toFixed(1)}px`);
  element.style.setProperty("--canvasly-move-y", `${y.toFixed(1)}px`);
  element.style.translate =
    "var(--canvasly-move-x, 0px) var(--canvasly-move-y, 0px)";
}

function applyFreeMovesToHtml(
  source: string,
  moves: PendingFreeMove[],
) {
  const doc = new DOMParser().parseFromString(source, "text/html");
  const before = doc.documentElement.outerHTML;
  for (const move of moves) {
    let element: Element | null = null;
    try {
      element = doc.querySelector(move.selector);
    } catch {
      return null;
    }
    if (
      !element ||
      element === doc.documentElement ||
      element === doc.body ||
      !(element instanceof HTMLElement)
    ) {
      return null;
    }
    setElementFreeMovePosition(element, move.x, move.y);
  }

  const after = doc.documentElement.outerHTML;
  if (after === before) return null;

  const documentMatch = /<html\b[\s\S]*<\/html\s*>/i.exec(source);
  if (!documentMatch || documentMatch.index === undefined) {
    return serializeDocument(doc);
  }
  return `${source.slice(0, documentMatch.index)}${after}${source.slice(documentMatch.index + documentMatch[0].length)}`;
}

function toSvgPath(points: Point[]) {
  if (!points.length) return "";
  return points.reduce(
    (path, point, index) =>
      `${path}${index === 0 ? "M" : " L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`,
    "",
  );
}

function serializeDocument(doc: Document) {
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

function hasReservedTransformAttributes(source: string) {
  return new RegExp(
    `${EDIT_TARGET_ATTRIBUTE}|${PLACEMENT_ANCHOR_ATTRIBUTE}|${INSERTION_SLOT_ATTRIBUTE}`,
    "i",
  ).test(source);
}

function clearReservedTransformAttributes(doc: Document) {
  for (const attribute of [
    EDIT_TARGET_ATTRIBUTE,
    PLACEMENT_ANCHOR_ATTRIBUTE,
    INSERTION_SLOT_ATTRIBUTE,
  ]) {
    doc.querySelectorAll(`[${attribute}]`).forEach((element) =>
      element.removeAttribute(attribute),
    );
  }
}

function normalizeTransformHtml(source: string) {
  if (!hasReservedTransformAttributes(source)) return source;
  const doc = new DOMParser().parseFromString(source, "text/html");
  clearReservedTransformAttributes(doc);
  return serializeDocument(doc);
}

function elementPathFromDocumentRoot(doc: Document, element: Element) {
  const path: number[] = [];
  let current: Element | null = element;
  while (current && current !== doc.documentElement) {
    const parent: Element | null = current.parentElement;
    if (!parent) return undefined;
    const index = Array.from(parent.children).indexOf(current);
    if (index < 0) return undefined;
    path.unshift(index);
    current = parent;
  }
  return current === doc.documentElement ? path : undefined;
}

function pathsMatch(first?: number[], second?: number[]) {
  return Boolean(
    first &&
    second &&
    first.length === second.length &&
    first.every((value, index) => value === second[index]),
  );
}

function isComponentInsertionInstruction(instruction: string) {
  const component =
    "组件|模块|区块|板块|卡片|按钮|表单|导航|菜单|横幅|通知|提示框|弹窗|列表|表格|图片|视频|页脚|页头|侧栏|工具栏|搜索框|输入框|图表";
  const chineseCreation = new RegExp(
    `(?:新增|新建|创建|插入|加入|放置|生成|做一个|加个|加一个|增加一个|增加一组|添加一个|添加一组|添加新的?)\\s*.{0,16}(?:${component})(?!\\s*(?:阴影|边框|圆角|间距|内边距|外边距|颜色|背景|样式|动效|层级))`,
    "i",
  );
  const englishCreation =
    /\b(?:add|append|insert|create|place|put|build|generate)\b(?!\s*(?:padding|margin|spacing|shadow|border|radius|color|background|contrast|hierarchy|style|animation|hover|font|size)\b)\s+(?:(?:a|an|one|new|another)\s+)?(?:component|section|card|button|form|panel|nav(?:bar)?|menu|banner|notice|alert|modal|list|table|image|video|footer|header|sidebar|toolbar|search|input|chart)\b|\bnew\s+(?:component|section|card|button|form|panel|nav(?:bar)?|menu|banner|notice|alert|modal|list|table|image|video|footer|header|sidebar|toolbar|search|input|chart)\b/i;
  return (
    chineseCreation.test(instruction) ||
    englishCreation.test(instruction) ||
    isComponentDuplicationInstruction(instruction)
  );
}

function isComponentDuplicationInstruction(instruction: string) {
  const chineseComponent =
    "组件|模块|区块|板块|卡片|按钮|表单|导航|菜单|横幅|通知|提示框|弹窗|列表|表格|图片|视频|页脚|页头|侧栏|工具栏|搜索框|输入框|图表";
  const chineseClone = new RegExp(
    `克隆\\s*(?:这个|该|当前|选中的?)?\\s*.{0,12}(?:${chineseComponent})|(?:${chineseComponent})\\s*.{0,12}克隆(?:到|至)?(?:下方|下面|后面|旁边)?`,
    "i",
  );
  const chineseCopy = new RegExp(
    `(?:复制|拷贝)\\s*(?:这个|该|当前|选中的?)?\\s*.{0,12}(?:${chineseComponent})|(?:${chineseComponent})\\s*.{0,12}(?:复制|拷贝)(?:到|至)?(?:下方|下面|后面|旁边)?`,
    "i",
  );
  const chineseStyleTransfer = new RegExp(
    `(?:复制|拷贝)[^。！？]{0,30}(?:${chineseComponent})(?:的)?\\s*(?:样式|风格|格式|外观|颜色|背景|边框|阴影|间距|内边距|外边距|字体|动效|交互)`,
    "i",
  );
  const englishClone =
    /\b(?:duplicate|clone)\b[\s\S]{0,50}\b(?:component|section|card|button|form|panel|nav(?:bar)?|menu|banner|notice|alert|modal|list|table|image|video|footer|header|sidebar|toolbar|search|input|chart)\b/i;
  const englishCopy =
    /\bcopy\s+(?:this|the|selected|a|an)\s+(?:[a-z][\w-]*\s+){0,2}(?:component|section|card|button|form|panel|nav(?:bar)?|menu|banner|notice|alert|modal|list|table|image|video|footer|header|sidebar|toolbar|search|input|chart)\b/i;
  const englishStyleTransfer =
    /\bcopy\b[\s\S]{0,50}\b(?:component|section|card|button|form|panel|nav(?:bar)?|menu|banner|notice|alert|modal|list|table|image|video|footer|header|sidebar|toolbar|search|input|chart)\b(?:'s|’s)?\s+(?:style|formatting|appearance|color|background|border|shadow|spacing|padding|margin|typography|font|animation|interaction)\b/i;
  return (
    chineseClone.test(instruction) ||
    englishClone.test(instruction) ||
    (chineseCopy.test(instruction) && !chineseStyleTransfer.test(instruction)) ||
    (englishCopy.test(instruction) && !englishStyleTransfer.test(instruction))
  );
}

function getSourceSiblingPlacement(
  doc: Document,
  selector: string,
  fallback?: SelectionPlacement,
): SelectionPlacement | undefined {
  let selected: Element | null = null;
  try {
    selected = doc.querySelector(selector);
  } catch {
    return undefined;
  }
  if (!selected) return undefined;

  let directChild = selected;
  let parent = selected.parentElement;
  while (parent && !canContainComponent(parent)) {
    if (RESTRICTIVE_CONTAINER_TAGS.has(parent.tagName)) return undefined;
    directChild = parent;
    parent = parent.parentElement;
  }
  if (!parent) return undefined;
  const index = Array.from(parent.children).indexOf(directChild);
  if (index < 0) return undefined;
  const next = directChild.nextElementSibling;
  return {
    relation: next ? "between" : "append",
    axis: fallback?.axis ?? "vertical",
    parentSelector: getUniqueSelector(parent),
    previousSelector: getUniqueSelector(directChild),
    nextSelector: next ? getUniqueSelector(next) : undefined,
    xPercent: fallback?.xPercent ?? 50,
    yPercent: fallback?.yPercent ?? 50,
  };
}

function prepareTransformHtml(
  source: string,
  selection: SelectionContext | null,
  instruction: string,
) {
  const normalizedSource = normalizeTransformHtml(source);
  const insertionRequested = Boolean(
    selection && isComponentInsertionInstruction(instruction),
  );
  const selectors = [
    selection?.selector,
    ...(selection?.targets?.map((target) => target.selector) ?? []),
  ].filter((selector): selector is string => Boolean(selector));
  if (!selection || (!selectors.length && !selection.placement)) {
    return {
      html: normalizedSource,
      baselineHtml: normalizedSource,
      selection,
      markerToken: null,
      insertionRequested,
      insertionExpected: false,
    };
  }

  const doc = new DOMParser().parseFromString(normalizedSource, "text/html");
  const markerToken = makeId("edit").replace(/[^a-zA-Z0-9-]/g, "");
  const markedElements: Element[] = [];
  const placementElements: Element[] = [];
  const anchors: string[] = [];
  const seen = new Set<Element>();

  for (const selector of selectors) {
    let element: Element | null = null;
    try {
      element = doc.querySelector(selector);
    } catch {
      continue;
    }
    if (!element || seen.has(element)) continue;
    seen.add(element);
    const value = `${markerToken}-${anchors.length + 1}`;
    element.setAttribute(EDIT_TARGET_ATTRIBUTE, value);
    markedElements.push(element);
    anchors.push(`[${EDIT_TARGET_ATTRIBUTE}="${value}"]`);
  }

  let placement = selection.placement ? { ...selection.placement } : undefined;
  if (selection.selector && isComponentDuplicationInstruction(instruction)) {
    placement = getSourceSiblingPlacement(doc, selection.selector, placement);
  }
  if (placement) {
    let parent: Element | null = null;
    let requestedPrevious: Element | null = null;
    let requestedNext: Element | null = null;
    try {
      parent = doc.querySelector(placement.parentSelector);
      requestedPrevious = placement.previousSelector
        ? doc.querySelector(placement.previousSelector)
        : null;
      requestedNext = placement.nextSelector
        ? doc.querySelector(placement.nextSelector)
        : null;
    } catch {
      parent = null;
    }

    let actualPrevious: Element | null = null;
    let actualNext: Element | null = null;
    if (parent && placement.relation === "prepend") {
      actualNext = parent.firstElementChild;
    } else if (parent && placement.relation === "append") {
      actualPrevious = parent.lastElementChild;
    } else if (parent && requestedNext?.parentElement === parent) {
      actualNext = requestedNext;
      actualPrevious = requestedNext.previousElementSibling;
    } else if (parent && requestedPrevious?.parentElement === parent) {
      actualPrevious = requestedPrevious;
      actualNext = requestedPrevious.nextElementSibling;
    }

    placement.previousSelector = actualPrevious
      ? getUniqueSelector(actualPrevious)
      : undefined;
    placement.nextSelector = actualNext ? getUniqueSelector(actualNext) : undefined;
  }
  const markPlacementElement = (
    selector: string | undefined,
    role: "parent" | "previous" | "next",
  ) => {
    if (!selector) return undefined;
    let element: Element | null = null;
    try {
      element = doc.querySelector(selector);
    } catch {
      return undefined;
    }
    if (!element) return undefined;
    const value = `${markerToken}-${role}`;
    element.setAttribute(PLACEMENT_ANCHOR_ATTRIBUTE, value);
    placementElements.push(element);
    return `[${PLACEMENT_ANCHOR_ATTRIBUTE}="${value}"]`;
  };

  if (placement) {
    placement.parentAnchor = markPlacementElement(placement.parentSelector, "parent");
    placement.previousAnchor = markPlacementElement(placement.previousSelector, "previous");
    placement.nextAnchor = markPlacementElement(placement.nextSelector, "next");
  }

  let slot: HTMLElement | null = null;
  let insertionExpected = false;
  const placementAttributesReady = Boolean(
    placement?.parentAnchor &&
    (!placement.previousSelector || placement.previousAnchor) &&
    (!placement.nextSelector || placement.nextAnchor),
  );
  if (placement && insertionRequested && placementAttributesReady) {
    const parent = doc.querySelector<HTMLElement>(placement.parentAnchor as string);
    const previous = placement.previousAnchor
      ? doc.querySelector(placement.previousAnchor)
      : null;
    const next = placement.nextAnchor
      ? doc.querySelector(placement.nextAnchor)
      : null;
    const boundaryReady = Boolean(
      parent &&
      (placement.relation === "between"
        ? previous?.parentElement === parent &&
          next?.parentElement === parent &&
          previous.nextElementSibling === next
        : placement.relation === "append"
          ? previous?.parentElement === parent && previous.nextElementSibling === null
          : next
            ? next.parentElement === parent && next.previousElementSibling === null
            : parent.children.length === 0),
    );
    if (parent && boundaryReady) {
      slot = doc.createElement("div");
      const value = `${markerToken}-slot`;
      slot.setAttribute(INSERTION_SLOT_ATTRIBUTE, value);
      placement.slotAnchor = `[${INSERTION_SLOT_ATTRIBUTE}="${value}"]`;
      if (next?.parentElement === parent) {
        parent.insertBefore(slot, next);
      } else if (previous?.parentElement === parent) {
        previous.after(slot);
      } else {
        parent.append(slot);
      }
      const parentPath = elementPathFromDocumentRoot(doc, parent);
      const childIndex = Array.from(parent.children).indexOf(slot);
      if (parentPath && childIndex >= 0) {
        placement.parentPath = parentPath;
        placement.childIndex = childIndex;
        insertionExpected = true;
      } else {
        slot.remove();
        slot = null;
        placement.slotAnchor = undefined;
      }
    }
  }

  if (!anchors.length && !placement?.parentAnchor) {
    return {
      html: normalizedSource,
      baselineHtml: normalizedSource,
      selection,
      markerToken: null,
      insertionRequested,
      insertionExpected: false,
    };
  }

  const html = serializeDocument(doc);
  slot?.remove();
  placementElements.forEach((element) => element.removeAttribute(PLACEMENT_ANCHOR_ATTRIBUTE));
  markedElements.forEach((element) => element.removeAttribute(EDIT_TARGET_ATTRIBUTE));
  return {
    html,
    baselineHtml: serializeDocument(doc),
    selection: { ...selection, anchors, placement },
    markerToken,
    insertionRequested,
    insertionExpected,
  };
}

function cleanTransformHtml(
  source: string,
  markerToken: string | null,
  insertionExpected: boolean,
  placement?: SelectionPlacement,
) {
  if (!markerToken && !hasReservedTransformAttributes(source)) {
    return { html: source, insertionApplied: !insertionExpected };
  }
  const doc = new DOMParser().parseFromString(source, "text/html");
  const slots = markerToken
    ? Array.from(
        doc.querySelectorAll(`[${INSERTION_SLOT_ATTRIBUTE}="${markerToken}-slot"]`),
      )
    : [];
  const parents = Array.from(
    doc.querySelectorAll(`[${PLACEMENT_ANCHOR_ATTRIBUTE}="${markerToken}-parent"]`),
  );
  const previousElements = Array.from(
    doc.querySelectorAll(`[${PLACEMENT_ANCHOR_ATTRIBUTE}="${markerToken}-previous"]`),
  );
  const nextElements = Array.from(
    doc.querySelectorAll(`[${PLACEMENT_ANCHOR_ATTRIBUTE}="${markerToken}-next"]`),
  );
  const allPlacementMarkers = doc.querySelectorAll(`[${PLACEMENT_ANCHOR_ATTRIBUTE}]`);
  const allSlots = Array.from(doc.querySelectorAll(`[${INSERTION_SLOT_ATTRIBUTE}]`));
  const expectsPrevious = Boolean(placement?.previousAnchor);
  const expectsNext = Boolean(placement?.nextAnchor);
  const expectedPlacementMarkerCount = 1 + Number(expectsPrevious) + Number(expectsNext);
  const parent = parents[0];
  const previous = previousElements[0];
  const next = nextElements[0];
  const slot = slots[0];
  const markersIntact =
    slots.length === 1 &&
    parents.length === 1 &&
    previousElements.length === Number(expectsPrevious) &&
    nextElements.length === Number(expectsNext) &&
    allPlacementMarkers.length === expectedPlacementMarkerCount &&
    allSlots.length === 1;
  const slotStayedAtBoundary =
    markersIntact &&
    slot.tagName === "DIV" &&
    slot.attributes.length === 1 &&
    slot.hasAttribute(INSERTION_SLOT_ATTRIBUTE) &&
    slot.parentElement === parent &&
    pathsMatch(
      placement?.parentPath,
      parent ? elementPathFromDocumentRoot(doc, parent) : undefined,
    ) &&
    Array.from(parent?.children ?? []).indexOf(slot) === placement?.childIndex &&
    slot.previousElementSibling === (expectsPrevious ? previous : null) &&
    slot.nextElementSibling === (expectsNext ? next : null);
  const insertionApplied =
    !insertionExpected ||
    (slotStayedAtBoundary && slot.children.length > 0);
  slots.forEach((slotElement) =>
    slotElement.replaceWith(...Array.from(slotElement.childNodes)),
  );
  clearReservedTransformAttributes(doc);
  return { html: serializeDocument(doc), insertionApplied };
}

function htmlIsUnchanged(result: string, baseline: string) {
  return result.trim() === baseline.trim();
}

function applyDemoEdit(
  source: string,
  instruction: string,
  selection: SelectionContext | null,
) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(source, "text/html");
  const normalized = instruction.toLowerCase();
  let target: HTMLElement | null = null;

  if (selection?.selector) {
    target = doc.querySelector<HTMLElement>(selection.selector);
  }
  if (!target && /标题|heading|headline|hero/.test(normalized)) {
    target = doc.querySelector<HTMLElement>("h1");
  }
  if (!target && /按钮|button|cta/.test(normalized)) {
    target = doc.querySelector<HTMLElement>(".primary-btn, button");
  }
  if (!target && /卡片|card|玻璃/.test(normalized)) {
    target = doc.querySelector<HTMLElement>(".route-card");
  }

  const changes: string[] = [];
  const root = doc.documentElement;

  if (/夏日|summer|明亮|fresh|清新|配色|color/.test(normalized)) {
    root.style.setProperty("--accent", "#f06f4f");
    root.style.setProperty("--paper", "#fffaf1");
    const orb = doc.querySelector<HTMLElement>(".orb-a");
    if (orb) orb.style.background = "#ffd7cb";
    changes.push("更新了主色与背景氛围");
  }

  if (/深色|dark|黑色|night/.test(normalized)) {
    const element = target ?? doc.querySelector<HTMLElement>(".route-card") ?? doc.body;
    element.style.background = "linear-gradient(145deg, #24212c, #141319)";
    element.style.color = "#ffffff";
    element.style.borderColor = "rgba(255,255,255,.14)";
    element.style.boxShadow = "0 30px 70px rgba(17,14,27,.32)";
    changes.push("应用了深色视觉层级");
  }

  if (/杂志|editorial|大|醒目|bold|impact/.test(normalized)) {
    const heading = target?.matches("h1, h2, h3")
      ? target
      : doc.querySelector<HTMLElement>("h1");
    if (heading) {
      heading.style.letterSpacing = "-.065em";
      heading.style.lineHeight = ".9";
      heading.style.fontStyle = "italic";
      heading.style.textWrap = "balance";
    }
    changes.push("强化了标题的编辑感");
  }

  if (/圆角|rounded|柔和|soft/.test(normalized)) {
    const element = target ?? doc.querySelector<HTMLElement>(".route-card");
    if (element) {
      element.style.borderRadius = "36px";
      element.style.overflow = "hidden";
    }
    changes.push("调整了圆角与边界");
  }

  if (/按钮|button|cta|层级/.test(normalized)) {
    const button = target?.matches("button, a")
      ? target
      : doc.querySelector<HTMLElement>(".primary-btn");
    if (button) {
      button.style.background = "linear-gradient(135deg, #7458e9, #9b7cff)";
      button.style.padding = "15px 23px";
      button.style.boxShadow = "0 14px 32px rgba(116,88,233,.3)";
      button.style.transform = "translateY(-1px)";
    }
    changes.push("增强了主按钮的对比度");
  }

  if (/留白|spacing|space|呼吸|宽松/.test(normalized)) {
    const element = target ?? doc.querySelector<HTMLElement>(".hero");
    if (element) {
      element.style.paddingTop = "72px";
      element.style.paddingBottom = "88px";
    }
    changes.push("增加了内容留白");
  }

  if (!changes.length) {
    const element = target ?? doc.querySelector<HTMLElement>(".route-card") ?? doc.body;
    element.style.boxShadow = "0 24px 64px rgba(92,72,151,.22)";
    element.style.transform = `${element.style.transform || ""} translateY(-3px)`.trim();
    changes.push(selection ? `优化了「${selection.label}」` : "优化了页面的视觉层次");
  }

  return {
    html: serializeDocument(doc),
    summary: changes.join("；"),
    updates: changes,
  };
}

function CoworkReportDetails({
  report,
  onChoose,
}: {
  report: CoworkReport;
  onChoose: (suggestion: CoworkSuggestion) => void;
}) {
  if (!report.updates.length && !report.issues.length && !report.suggestions.length) {
    return null;
  }

  return (
    <div className={`cowork-report ${report.status}`} aria-label="Agent 执行报告">
      {!!report.updates.length && (
        <section>
          <strong><Check size={12} />已更新</strong>
          <ul>{report.updates.map((item) => <li key={item}>{item}</li>)}</ul>
        </section>
      )}
      {!!report.issues.length && (
        <section className="cowork-report-issues">
          <strong><CircleAlert size={12} />限制与冲突</strong>
          <ul>{report.issues.map((item) => <li key={item}>{item}</li>)}</ul>
        </section>
      )}
      {!!report.suggestions.length && (
        <section className="cowork-report-options">
          <strong><Sparkles size={12} />可选方案</strong>
          <div>
            {report.suggestions.map((suggestion) => (
              <button
                key={`${suggestion.label}-${suggestion.prompt}`}
                onClick={() => onChoose(suggestion)}
                type="button"
              >
                <span>
                  <b>{suggestion.label}</b>
                  {suggestion.description && <small>{suggestion.description}</small>}
                </span>
                <ArrowRight size={12} />
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function ToolButton({
  active,
  disabled = false,
  label,
  shortcut,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  label: string;
  shortcut: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`tool-button ${active ? "active" : ""}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={`${label} (${shortcut})`}
      title={`${label} · ${shortcut}`}
      type="button"
    >
      {children}
      <span className="tool-tip">
        {label}<kbd>{shortcut}</kbd>
      </span>
    </button>
  );
}

export default function Home() {
  const [toolMode, setToolMode] = useState<ToolMode>("select");
  const [device, setDevice] = useState<DeviceMode>("desktop");
  const [panelTab, setPanelTab] = useState<PanelTab>("chat");
  const [collaborationMode, setCollaborationMode] =
    useState<CollaborationMode>("cowork");
  const [panelOpen, setPanelOpen] = useState(true);
  const [canvasFitScale, setCanvasFitScale] = useState(1);
  const [canvasZoom, setCanvasZoom] = useState(1);
  const [history, setHistory] = useState<string[]>([STARTER_HTML]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [codeDraft, setCodeDraft] = useState(STARTER_HTML);
  const [projectName, setProjectName] = useState("Northstar landing");
  const [projectBaseline, setProjectBaseline] = useState(STARTER_HTML);
  const [savedHtml, setSavedHtml] = useState(STARTER_HTML);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [pendingProject, setPendingProject] = useState<ProjectReplacement | null>(null);
  const [selection, setSelection] = useState<SelectionContext | null>(null);
  const [hoverRect, setHoverRect] = useState<Rect | null>(null);
  const [isMovingElement, setIsMovingElement] = useState(false);
  const [movePreview, setMovePreview] = useState<Point | null>(null);
  const [stagedMoves, setStagedMoves] = useState<PendingFreeMove[]>([]);
  const [freeMoveSteps, setFreeMoveSteps] = useState<FreeMoveStep[]>([]);
  const [savedMoveHtml, setSavedMoveHtml] = useState<string | null>(null);
  const [regionRect, setRegionRect] = useState<Rect | null>(null);
  const [drawPoints, setDrawPoints] = useState<Point[]>([]);
  const [coworkMessages, setCoworkMessages] =
    useState<ChatMessage[]>(INITIAL_COWORK_MESSAGES);
  const [chatMessages, setChatMessages] =
    useState<ChatMessage[]>(INITIAL_CHAT_MESSAGES);
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isWorking, setIsWorking] = useState(false);
  const [activeAgentJob, setActiveAgentJob] = useState<AgentJob | null>(null);
  const [agentQueue, setAgentQueue] = useState<AgentJob[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [desktopInfo, setDesktopInfo] = useState<DesktopInfo | null>(null);
  const [desktopUpdate, setDesktopUpdate] =
    useState<DesktopUpdateState | null>(null);
  const [desktopPersistenceReady, setDesktopPersistenceReady] = useState(false);
  const [desktopPersistenceError, setDesktopPersistenceError] =
    useState<string | null>(null);
  const [desktopSavedAt, setDesktopSavedAt] = useState<string | null>(null);
  const [modelConfig, setModelConfig] = useState<ModelConfig>({
    providerId: initialProvider.id,
    protocol: initialProvider.protocol,
    baseUrl: initialProvider.baseUrl,
    model: initialProvider.model,
    apiKey: "",
  });
  const [draftConfig, setDraftConfig] = useState<ModelConfig>(modelConfig);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const iframeCleanupRef = useRef<() => void>(() => undefined);
  const canvasScrollerRef = useRef<HTMLDivElement>(null);
  const canvasZoomAnchorRef = useRef<{
    clientX: number;
    clientY: number;
    canvasX: number;
    canvasY: number;
    targetScale: number;
  } | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const openHtmlInputRef = useRef<HTMLInputElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const projectTriggerRef = useRef<HTMLButtonElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const pointerOriginRef = useRef<Point | null>(null);
  const pointerActiveRef = useRef(false);
  const selectionRef = useRef<SelectionContext | null>(null);
  const freeMoveDragRef = useRef<FreeMoveDrag | null>(null);
  const stagedMovesRef = useRef<Map<string, PendingFreeMove>>(new Map());
  const documentRevisionRef = useRef(0);
  const hasAgentWorkRef = useRef(false);
  const promptHistoryRef = useRef<Record<CollaborationMode, string[]>>({
    cowork: [],
    chat: [],
  });
  const promptHistoryIndexRef = useRef<number | null>(null);
  const promptHistoryDraftRef = useRef("");
  const promptComposingRef = useRef(false);
  const navigationIssueRef = useRef({ key: "", timestamp: 0 });
  const desktopSnapshotRef = useRef<DesktopProjectSnapshot | null>(null);
  const desktopSaveErrorRef = useRef("");

  const currentHtml = history[historyIndex];
  const previewHtml = useMemo(() => safePreviewHtml(currentHtml), [currentHtml]);
  const provider =
    PROVIDERS.find((item) => item.id === modelConfig.providerId) ?? PROVIDERS[0];
  const deviceSize = DEVICE_SIZES[device];
  const canvasScale = clampCanvasScale(canvasFitScale * canvasZoom);
  const canvasScalePercent = Math.round(canvasScale * 100);
  const canvasIsFit = Math.abs(canvasZoom - 1) < 0.01;
  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < history.length - 1;
  const hasPendingCodeDraft = codeDraft !== currentHtml;
  const hasStagedMoves = stagedMoves.length > 0;
  const hasAgentWork =
    isWorking || activeAgentJob !== null || agentQueue.length > 0;
  const messages =
    collaborationMode === "cowork" ? coworkMessages : chatMessages;
  const desktopSnapshot = useMemo<DesktopProjectSnapshot>(
    () => ({
      schemaVersion: 1,
      projectName,
      history,
      historyIndex,
      codeDraft,
      projectBaseline,
      savedHtml,
      savedAt: new Date().toISOString(),
    }),
    [
      codeDraft,
      history,
      historyIndex,
      projectBaseline,
      projectName,
      savedHtml,
    ],
  );

  const appendModeMessage = useCallback(
    (mode: CollaborationMode, message: ChatMessage) => {
      const setter = mode === "cowork" ? setCoworkMessages : setChatMessages;
      setter((items) => [...items, message]);
    },
    [],
  );

  const updateModeMessage = useCallback(
    (
      mode: CollaborationMode,
      messageId: string,
      update: Partial<ChatMessage>,
    ) => {
      const setter = mode === "cowork" ? setCoworkMessages : setChatMessages;
      setter((items) =>
        items.map((item) =>
          item.id === messageId ? { ...item, ...update } : item,
        ),
      );
    },
    [],
  );
  const hasUnsavedChanges =
    currentHtml !== savedHtml || hasPendingCodeDraft || hasStagedMoves;

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => {
    const desktop = window.canvaslyDesktop;
    if (!desktop) return;

    let disposed = false;
    const unsubscribe = desktop.onUpdateState((state) => {
      if (!disposed) setDesktopUpdate(state);
    });
    void (async () => {
      try {
        const [info, update] = await Promise.all([
          desktop.getInfo(),
          desktop.getUpdateState(),
        ]);
        if (disposed) return;
        setDesktopInfo(info);
        setDesktopUpdate(update);

        try {
          const snapshot = await desktop.loadProject();
          if (disposed) return;
          if (snapshot) {
            documentRevisionRef.current += 1;
            setProjectName(snapshot.projectName);
            setHistory(snapshot.history);
            setHistoryIndex(snapshot.historyIndex);
            setCodeDraft(snapshot.codeDraft);
            setProjectBaseline(snapshot.projectBaseline);
            setSavedHtml(snapshot.savedHtml);
            setDesktopSavedAt(snapshot.savedAt);
          }
          setDesktopPersistenceReady(true);
        } catch (error) {
          if (disposed) return;
          const message = desktopErrorMessage(error);
          console.error("[Canvasly] Desktop project restore failed", error);
          setDesktopPersistenceError(message);
          showToast(`桌面项目恢复失败：${message}`);
        }
      } catch (error) {
        if (disposed) return;
        const message = desktopErrorMessage(error);
        console.error("[Canvasly] Desktop initialization failed", error);
        showToast(`桌面功能初始化失败：${message}`);
      }
    })();
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [showToast]);

  useEffect(() => {
    desktopSnapshotRef.current = desktopSnapshot;
  }, [desktopSnapshot]);

  useEffect(() => {
    const desktop = window.canvaslyDesktop;
    if (!desktop || !desktopInfo || !desktopPersistenceReady) return;

    const timeout = window.setTimeout(() => {
      void desktop
        .saveProject(desktopSnapshot)
        .then(({ savedAt }) => {
          setDesktopSavedAt(savedAt);
          desktopSaveErrorRef.current = "";
        })
        .catch((error: unknown) => {
          const message = desktopErrorMessage(error);
          console.error("[Canvasly] Desktop autosave failed", error);
          if (desktopSaveErrorRef.current !== message) {
            desktopSaveErrorRef.current = message;
            showToast(`桌面自动保存失败：${message}`);
          }
        });
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [
    desktopInfo,
    desktopPersistenceReady,
    desktopSnapshot,
    showToast,
  ]);

  useEffect(() => {
    const desktop = window.canvaslyDesktop;
    if (
      !desktop ||
      !desktopInfo ||
      !desktopPersistenceReady ||
      desktopPersistenceError
    ) {
      return;
    }
    const saveBeforeUnload = () => {
      const snapshot = desktopSnapshotRef.current;
      if (!snapshot) return;
      try {
        const result = desktop.saveProjectBeforeUnload(snapshot);
        if (!result.ok) {
          console.error(
            `[Canvasly] Desktop unload save failed: ${result.message}`,
          );
        }
      } catch (error) {
        console.error("[Canvasly] Desktop unload save failed", error);
      }
    };
    window.addEventListener("beforeunload", saveBeforeUnload);
    return () => window.removeEventListener("beforeunload", saveBeforeUnload);
  }, [
    desktopInfo,
    desktopPersistenceError,
    desktopPersistenceReady,
  ]);

  const chooseCoworkSuggestion = useCallback((suggestion: CoworkSuggestion) => {
    setCollaborationMode("cowork");
    setPanelOpen(true);
    setPanelTab("chat");
    setPrompt(suggestion.prompt);
    promptHistoryIndexRef.current = null;
    promptHistoryDraftRef.current = "";
    window.setTimeout(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(
        suggestion.prompt.length,
        suggestion.prompt.length,
      );
    }, 60);
  }, []);

  const reportNavigationIssue = useCallback((
    summary: string,
    issue: string,
    suggestions: CoworkSuggestion[],
  ) => {
    const key = `${summary}:${issue}`;
    const now = Date.now();
    if (
      navigationIssueRef.current.key === key &&
      now - navigationIssueRef.current.timestamp < 1_500
    ) {
      return;
    }
    navigationIssueRef.current = { key, timestamp: now };
    appendModeMessage("cowork", {
      id: makeId("navigation-blocked"),
      role: "assistant",
      text: "导航需要补充配置",
      detail: summary,
      report: {
        status: "blocked",
        updates: [],
        issues: [issue],
        suggestions,
      },
    });
    setCollaborationMode("cowork");
    setPanelOpen(true);
    setPanelTab("chat");
    showToast(summary);
  }, [appendModeMessage, showToast]);

  const commitHtml = useCallback(
    (nextHtml: string) => {
      if (!nextHtml.trim() || nextHtml === currentHtml) return;
      documentRevisionRef.current += 1;
      const nextHistory = history.slice(0, historyIndex + 1);
      nextHistory.push(nextHtml);
      setHistory(nextHistory.slice(-30));
      setHistoryIndex(Math.min(nextHistory.length - 1, 29));
      setCodeDraft(nextHtml);
      setSelection(null);
      setRegionRect(null);
      setDrawPoints([]);
    },
    [currentHtml, history, historyIndex],
  );

  const undo = useCallback(() => {
    if (!canUndo) return;
    documentRevisionRef.current += 1;
    const nextIndex = historyIndex - 1;
    setHistoryIndex(nextIndex);
    setCodeDraft(history[nextIndex]);
    setSelection(null);
  }, [canUndo, history, historyIndex]);

  const redo = useCallback(() => {
    if (!canRedo) return;
    documentRevisionRef.current += 1;
    const nextIndex = historyIndex + 1;
    setHistoryIndex(nextIndex);
    setCodeDraft(history[nextIndex]);
    setSelection(null);
  }, [canRedo, history, historyIndex]);

  const resetIframeInteractionStyles = useCallback((mode: ToolMode) => {
    const body = iframeRef.current?.contentDocument?.body;
    if (!body) return;
    body.style.userSelect = "";
    body.style.touchAction = mode === "move" && !isWorking ? "none" : "";
    body.style.cursor = isWorking
      ? "wait"
      : mode === "select" || mode === "interact"
        ? "default"
        : mode === "move"
          ? "grab"
          : "crosshair";
  }, [isWorking]);

  const restoreFreeMovePreview = useCallback(
    (move: PendingFreeMove | FreeMoveDrag | null) => {
      if (!move) return;
      const doc = iframeRef.current?.contentDocument;
      let element: HTMLElement | null = "element" in move ? move.element : null;
      if (!element && doc) {
        try {
          element = doc.querySelector<HTMLElement>(move.selector);
        } catch {
          element = null;
        }
      }
      if (!element) return;
      if (move.originalX) {
        element.style.setProperty("--canvasly-move-x", move.originalX);
      } else {
        element.style.removeProperty("--canvasly-move-x");
      }
      if (move.originalY) {
        element.style.setProperty("--canvasly-move-y", move.originalY);
      } else {
        element.style.removeProperty("--canvasly-move-y");
      }
      element.style.translate = move.originalTranslate;
      element.style.outline = move.originalOutline;
      element.style.outlineOffset = move.originalOutlineOffset;
    },
    [],
  );

  const abortActiveFreeMove = useCallback(() => {
    const drag = freeMoveDragRef.current;
    if (!drag) return;
    if (drag.wasStaged) {
      setElementFreeMovePosition(drag.element, drag.beforeX, drag.beforeY);
    } else {
      restoreFreeMovePreview(drag);
    }
    freeMoveDragRef.current = null;
    setIsMovingElement(false);
    setMovePreview(null);
  }, [restoreFreeMovePreview]);

  const discardStagedMoves = useCallback(() => {
    abortActiveFreeMove();
    for (const move of stagedMovesRef.current.values()) {
      restoreFreeMovePreview(move);
    }
    stagedMovesRef.current.clear();
    setStagedMoves([]);
    setFreeMoveSteps([]);
    setMovePreview(null);
    setSelection(null);
    showToast("已放弃所有临时移动");
  }, [abortActiveFreeMove, restoreFreeMovePreview, showToast]);

  const undoStagedMove = useCallback(() => {
    const step = freeMoveSteps[freeMoveSteps.length - 1];
    if (!step) return;
    const remainingSteps = freeMoveSteps.slice(0, -1);
    const previousStep = [...remainingSteps]
      .reverse()
      .find((candidate) => candidate.selector === step.selector);
    const staged = stagedMovesRef.current.get(step.selector);
    const doc = iframeRef.current?.contentDocument;
    let element: HTMLElement | null = null;
    try {
      element = doc?.querySelector<HTMLElement>(step.selector) ?? null;
    } catch {
      element = null;
    }

    if (!staged) return;
    if (previousStep) {
      const nextMove = {
        ...staged,
        x: previousStep.afterX,
        y: previousStep.afterY,
      };
      stagedMovesRef.current.set(step.selector, nextMove);
      if (element) {
        setElementFreeMovePosition(element, nextMove.x, nextMove.y);
      }
    } else {
      restoreFreeMovePreview(staged);
      stagedMovesRef.current.delete(step.selector);
    }
    setFreeMoveSteps(remainingSteps);
    setStagedMoves(Array.from(stagedMovesRef.current.values()));
    setSelection(null);
  }, [freeMoveSteps, restoreFreeMovePreview]);

  const confirmStagedMoves = useCallback(() => {
    abortActiveFreeMove();
    const moves = Array.from(stagedMovesRef.current.values());
    if (!moves.length) return;
    const movedHtml = applyFreeMovesToHtml(currentHtml, moves);
    if (!movedHtml) {
      showToast("无法保存当前移动，请重试");
      return;
    }
    stagedMovesRef.current.clear();
    setStagedMoves([]);
    setFreeMoveSteps([]);
    setMovePreview(null);
    setSelection(null);
    commitHtml(movedHtml);
    setSavedMoveHtml(movedHtml);
    showToast(`已渲染 ${moves.length} 个组件的位置`);
  }, [abortActiveFreeMove, commitHtml, currentHtml, showToast]);

  const undoSavedMove = useCallback(() => {
    if (currentHtml !== savedMoveHtml || !canUndo) return;
    undo();
    setSavedMoveHtml(null);
  }, [canUndo, currentHtml, savedMoveHtml, undo]);

  const clearSelection = useCallback(() => {
    abortActiveFreeMove();
    setSelection(null);
    setRegionRect(null);
    setDrawPoints([]);
    setHoverRect(null);
    setIsMovingElement(false);
    setMovePreview(null);
    freeMoveDragRef.current = null;
    resetIframeInteractionStyles(toolMode);
  }, [abortActiveFreeMove, resetIframeInteractionStyles, toolMode]);

  const activateTool = useCallback((mode: ToolMode) => {
    if (mode === "move" && hasPendingCodeDraft) {
      setPanelOpen(true);
      setPanelTab("code");
      showToast("请先应用或放弃 HTML 草稿，再移动组件");
      return;
    }
    abortActiveFreeMove();
    setHoverRect(null);
    setToolMode(mode);
    resetIframeInteractionStyles(mode);
  }, [abortActiveFreeMove, hasPendingCodeDraft, resetIframeInteractionStyles, showToast]);

  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  useEffect(() => {
    hasAgentWorkRef.current = hasAgentWork;
  }, [hasAgentWork]);

  useEffect(() => {
    stagedMovesRef.current = new Map(
      stagedMoves.map((move) => [move.selector, move]),
    );
  }, [stagedMoves]);

  useEffect(() => {
    const scroller = canvasScrollerRef.current;
    if (!scroller) return;

    let animationFrame = 0;
    const updateScale = () => {
      const style = window.getComputedStyle(scroller);
      scroller.style.setProperty(
        "--canvas-pan-x",
        `${Math.round(scroller.clientWidth / 2)}px`,
      );
      scroller.style.setProperty(
        "--canvas-pan-y",
        `${Math.round(scroller.clientHeight / 2)}px`,
      );
      const horizontalPadding =
        Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
      const verticalPadding =
        Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
      const availableWidth = Math.max(1, scroller.clientWidth - horizontalPadding);
      const availableHeight = Math.max(1, scroller.clientHeight - verticalPadding);
      const nextScale = Math.max(
        0.25,
        Math.min(
          1,
          availableWidth / deviceSize.width,
          availableHeight / deviceSize.height,
        ),
      );
      setCanvasFitScale((current) =>
        Math.abs(current - nextScale) < 0.0005
          ? current
          : Number(nextScale.toFixed(5)),
      );
    };
    const scheduleScaleUpdate = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(updateScale);
    };
    const observer = new ResizeObserver(scheduleScaleUpdate);
    observer.observe(scroller);
    window.addEventListener("resize", scheduleScaleUpdate);
    scheduleScaleUpdate();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", scheduleScaleUpdate);
      window.cancelAnimationFrame(animationFrame);
    };
  }, [deviceSize.height, deviceSize.width, panelOpen]);

  const setCanvasScaleAroundPoint = useCallback(
    (
      nextScale: number,
      clientPoint?: { x: number; y: number },
    ) => {
      const scroller = canvasScrollerRef.current;
      const stage = scroller?.querySelector<HTMLElement>(".device-stage");
      const previousScale = canvasScale;
      const clampedScale = clampCanvasScale(nextScale);
      if (
        !scroller ||
        !stage ||
        Math.abs(clampedScale - previousScale) < 0.001
      ) {
        return;
      }

      const point = clientPoint ?? {
        x: scroller.getBoundingClientRect().left + scroller.clientWidth / 2,
        y: scroller.getBoundingClientRect().top + scroller.clientHeight / 2,
      };
      const previousStageRect = stage.getBoundingClientRect();
      const canvasPoint = {
        x: (point.x - previousStageRect.left) / previousScale,
        y: (point.y - previousStageRect.top) / previousScale,
      };
      canvasZoomAnchorRef.current = {
        clientX: point.x,
        clientY: point.y,
        canvasX: canvasPoint.x,
        canvasY: canvasPoint.y,
        targetScale: clampedScale,
      };
      setCanvasZoom(clampedScale / canvasFitScale);
    },
    [canvasFitScale, canvasScale],
  );

  useLayoutEffect(() => {
    const anchor = canvasZoomAnchorRef.current;
    const scroller = canvasScrollerRef.current;
    const stage = scroller?.querySelector<HTMLElement>(".device-stage");
    if (
      !anchor ||
      !scroller ||
      !stage ||
      Math.abs(anchor.targetScale - canvasScale) >= 0.001
    ) {
      return;
    }
    const stageRect = stage.getBoundingClientRect();
    scroller.scrollLeft +=
      stageRect.left + anchor.canvasX * canvasScale - anchor.clientX;
    scroller.scrollTop +=
      stageRect.top + anchor.canvasY * canvasScale - anchor.clientY;
    canvasZoomAnchorRef.current = null;
  }, [canvasScale]);

  useEffect(() => {
    const scroller = canvasScrollerRef.current;
    if (!scroller) return;
    const handleCanvasWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const iframeRect = iframeRef.current?.getBoundingClientRect();
      const iframeOwnsGesture =
        toolMode !== "region" &&
        toolMode !== "draw" &&
        iframeRect &&
        event.clientX >= iframeRect.left &&
        event.clientX <= iframeRect.right &&
        event.clientY >= iframeRect.top &&
        event.clientY <= iframeRect.bottom;
      if (iframeOwnsGesture) return;
      const factor = Math.exp(
        -event.deltaY * CANVAS_WHEEL_ZOOM_SENSITIVITY,
      );
      setCanvasScaleAroundPoint(canvasScale * factor, {
        x: event.clientX,
        y: event.clientY,
      });
    };
    scroller.addEventListener("wheel", handleCanvasWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", handleCanvasWheel);
  }, [canvasScale, setCanvasScaleAroundPoint, toolMode]);

  const resetCanvasZoom = useCallback(() => {
    setCanvasScaleAroundPoint(canvasFitScale);
  }, [canvasFitScale, setCanvasScaleAroundPoint]);

  const changeDevice = (mode: DeviceMode) => {
    setCanvasZoom(1);
    setDevice(mode);
  };

  const wireIframe = useCallback(() => {
    const iframe = iframeRef.current;
    const doc = iframe?.contentDocument;
    if (!iframe || !doc) return () => undefined;

    resetIframeInteractionStyles(toolMode);
    const ElementCtor = doc.defaultView?.Element;
    for (const move of stagedMovesRef.current.values()) {
      let element: HTMLElement | null = null;
      try {
        element = doc.querySelector<HTMLElement>(move.selector);
      } catch {
        element = null;
      }
      if (element) setElementFreeMovePosition(element, move.x, move.y);
    }

    const toFrameRect = (rect: Rect) => {
      const iframeRect = iframe.getBoundingClientRect();
      const frameRect = iframe.parentElement?.getBoundingClientRect() ?? iframeRect;
      return {
        x: rect.x + (iframeRect.left - frameRect.left) / canvasScale,
        y: rect.y + (iframeRect.top - frameRect.top) / canvasScale,
        width: rect.width,
        height: rect.height,
      };
    };

    const updateRect = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return toFrameRect({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
    };

    const handleMove = (event: Event) => {
      if (!ElementCtor || !(event.target instanceof ElementCtor)) {
        return;
      }
      if (toolMode === "select") {
        setHoverRect(updateRect(event.target));
        return;
      }
      if (toolMode !== "move" || isWorking) return;
      const drag = freeMoveDragRef.current;
      if (!drag) {
        setHoverRect(updateRect(event.target));
        return;
      }

      const pointerEvent = event as globalThis.PointerEvent;
      drag.x = drag.beforeX + pointerEvent.clientX - drag.startX;
      drag.y = drag.beforeY + pointerEvent.clientY - drag.startY;
      setElementFreeMovePosition(drag.element, drag.x, drag.y);
      setMovePreview({ x: drag.x, y: drag.y });
    };

    const handleLeave = () => {
      if (!freeMoveDragRef.current) setHoverRect(null);
    };

    const handleIframeWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const iframeRect = iframe.getBoundingClientRect();
      const factor = Math.exp(
        -event.deltaY * CANVAS_WHEEL_ZOOM_SENSITIVITY,
      );
      setCanvasScaleAroundPoint(canvasScale * factor, {
        x: iframeRect.left + event.clientX * canvasScale,
        y: iframeRect.top + event.clientY * canvasScale,
      });
    };

    const handlePointerDown = (event: Event) => {
      if (
        toolMode !== "move" ||
        isWorking ||
        !ElementCtor ||
        !(event.target instanceof ElementCtor)
      ) {
        return;
      }
      const pointerEvent = event as globalThis.PointerEvent;
      const clicked = event.target;
      const selected = selectionRef.current?.selector
        ? doc.querySelector(selectionRef.current.selector)
        : null;
      const target = selected?.contains(clicked) ? selected : clicked;
      const HTMLElementCtor = doc.defaultView?.HTMLElement;
      if (
        !HTMLElementCtor ||
        !(target instanceof HTMLElementCtor) ||
        ["HTML", "BODY", "HEAD", "SCRIPT", "STYLE"].includes(target.tagName)
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      target.setPointerCapture?.(pointerEvent.pointerId);
      const selector = getUniqueSelector(target);
      const staged = stagedMovesRef.current.get(selector);
      const beforeX = Number.parseFloat(
        target.style.getPropertyValue("--canvasly-move-x"),
      ) || 0;
      const beforeY = Number.parseFloat(
        target.style.getPropertyValue("--canvasly-move-y"),
      ) || 0;
      freeMoveDragRef.current = {
        selector,
        label: staged?.label ?? getElementLabel(target),
        x: beforeX,
        y: beforeY,
        beforeX,
        beforeY,
        startX: pointerEvent.clientX,
        startY: pointerEvent.clientY,
        wasStaged: Boolean(staged),
        originalTranslate: staged?.originalTranslate ?? target.style.translate,
        originalX:
          staged?.originalX ?? target.style.getPropertyValue("--canvasly-move-x"),
        originalY:
          staged?.originalY ?? target.style.getPropertyValue("--canvasly-move-y"),
        originalOutline: staged?.originalOutline ?? target.style.outline,
        originalOutlineOffset:
          staged?.originalOutlineOffset ?? target.style.outlineOffset,
        element: target,
      };
      target.style.outline = "2px solid #21b987";
      target.style.outlineOffset = "4px";
      setIsMovingElement(true);
      setHoverRect(null);
      setMovePreview({ x: beforeX, y: beforeY });
      setSelection({
        type: "element",
        label: `自由移动 · ${getElementLabel(target)}`,
        selector,
        html: target.outerHTML.slice(0, 2600),
        placement: getElementPlacement(doc, target),
        rect: updateRect(target),
      });
      doc.body.style.cursor = "grabbing";
      doc.body.style.userSelect = "none";
    };

    const teardownMove = () => {
      freeMoveDragRef.current = null;
      setIsMovingElement(false);
      doc.body.style.cursor = "grab";
      doc.body.style.userSelect = "";
      doc.body.style.touchAction = "none";
    };

    const finishMove = (event: Event) => {
      const drag = freeMoveDragRef.current;
      if (toolMode !== "move" || !drag) return;
      event.preventDefault();
      teardownMove();
      drag.element.style.outline = drag.originalOutline;
      drag.element.style.outlineOffset = drag.originalOutlineOffset;
      if (
        Math.abs(drag.x - drag.beforeX) < 0.5 &&
        Math.abs(drag.y - drag.beforeY) < 0.5
      ) {
        setMovePreview(null);
        return;
      }
      const stagedMove: PendingFreeMove = {
        selector: drag.selector,
        label: drag.label,
        x: drag.x,
        y: drag.y,
        originalTranslate: drag.originalTranslate,
        originalX: drag.originalX,
        originalY: drag.originalY,
        originalOutline: drag.originalOutline,
        originalOutlineOffset: drag.originalOutlineOffset,
      };
      stagedMovesRef.current.set(drag.selector, stagedMove);
      setStagedMoves(Array.from(stagedMovesRef.current.values()));
      setFreeMoveSteps((steps) => [
        ...steps,
        {
          selector: drag.selector,
          beforeX: drag.beforeX,
          beforeY: drag.beforeY,
          afterX: drag.x,
          afterY: drag.y,
        },
      ]);
      setMovePreview(null);
      setSavedMoveHtml(null);
      setSelection((current) =>
        current
          ? {
              ...current,
              label: `已暂存 · ${drag.label}`,
              rect: updateRect(drag.element),
            }
          : current,
      );
    };

    const cancelMove = (event: Event) => {
      if (toolMode !== "move" || !freeMoveDragRef.current) return;
      event.preventDefault();
      abortActiveFreeMove();
      doc.body.style.cursor = "grab";
      doc.body.style.userSelect = "";
    };

    const handleClick = (event: Event) => {
      if (!ElementCtor || !(event.target instanceof ElementCtor)) {
        return;
      }
      const clickedElement = event.target;
      if (toolMode === "interact") {
        const anchor = clickedElement.closest<HTMLAnchorElement>("a[href]");
        const button = clickedElement.closest<HTMLElement>("button, [role='button']");
        if (!anchor && !button) return;

        const control = anchor ?? button;
        const controlName =
          control.getAttribute("aria-label") ||
          control.textContent?.replace(/\s+/g, " ").trim().slice(0, 52) ||
          "这个控件";
        const form = button?.closest("form");
        const destination = (
          anchor?.getAttribute("href") ||
          button?.getAttribute("data-href") ||
          button?.getAttribute("data-url") ||
          button?.getAttribute("data-target") ||
          button?.getAttribute("formaction") ||
          form?.getAttribute("action") ||
          ""
        ).trim();
        const navigationSuggestions: CoworkSuggestion[] = [
          {
            label: "改为页内导航",
            description: "创建真实目标区块，并使用 #id 语义链接。",
            prompt: `把“${controlName}”改成可用的页内导航。使用语义化 <a href="#目标-id">，并为对应内容区添加同名 id；不要使用 onclick 或脚本。`,
          },
          {
            label: "连接真实页面",
            description: "提供完整 HTTPS 地址后再配置跳转。",
            prompt: `把“${controlName}”改成真实页面链接。我会补充完整 HTTPS 目标地址；不要使用 # 占位或相对页面路径。`,
          },
        ];

        if (!destination || destination === "#") {
          event.preventDefault();
          event.stopPropagation();
          reportNavigationIssue(
            `“${controlName}”尚未配置跳转目标`,
            anchor
              ? "当前链接仍是 # 占位符，没有对应的页面或区块。"
              : "当前按钮没有 href、data-href、表单 action；预览出于安全原因也不会执行 onclick 脚本。",
            navigationSuggestions,
          );
          return;
        }

        if (destination.startsWith("#")) {
          event.preventDefault();
          event.stopPropagation();
          let targetId = destination.slice(1);
          try {
            targetId = decodeURIComponent(targetId);
          } catch {
            // Keep the literal target so the missing-target report remains useful.
          }
          const destinationElement = doc.getElementById(targetId);
          if (!destinationElement) {
            reportNavigationIssue(
              `找不到“${controlName}”的目标区块`,
              `链接指向 ${destination}，但当前 HTML 中没有 id="${targetId}" 的元素。`,
              navigationSuggestions,
            );
            return;
          }
          const scroller = doc.body;
          const targetTop = destinationElement.getBoundingClientRect().top + scroller.scrollTop;
          scroller.scrollTop = targetTop;
          showToast(`已跳转到“${controlName}”`);
          return;
        }

        const hasExplicitProtocol = /^[a-z][a-z\d+.-]*:/i.test(destination);
        if (!hasExplicitProtocol && !destination.startsWith("//")) {
          event.preventDefault();
          event.stopPropagation();
          reportNavigationIssue(
            `预览无法打开相对页面“${destination}”`,
            "Canvasly 当前编辑的是单个独立 HTML，未加载该相对路径对应的第二个页面。",
            navigationSuggestions,
          );
          return;
        }

        let destinationUrl: URL;
        try {
          destinationUrl = new URL(destination, doc.baseURI);
        } catch {
          event.preventDefault();
          reportNavigationIssue(
            `“${controlName}”的地址无效`,
            `无法解析导航地址：${destination}`,
            navigationSuggestions,
          );
          return;
        }
        if (!["http:", "https:", "mailto:", "tel:"].includes(destinationUrl.protocol)) {
          event.preventDefault();
          event.stopPropagation();
          reportNavigationIssue(
            `“${controlName}”使用了不受支持的协议`,
            `预览不会执行 ${destinationUrl.protocol} 链接；脚本和不安全协议已被禁用。`,
            navigationSuggestions,
          );
          return;
        }

        if (anchor) {
          anchor.target = "_blank";
          anchor.rel = "noopener noreferrer";
          showToast(`已打开“${controlName}”`);
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        doc.defaultView?.open(destinationUrl.href, "_blank", "noopener,noreferrer");
        showToast(`已打开“${controlName}”`);
        return;
      }
      if (toolMode !== "select") return;
      event.preventDefault();
      event.stopPropagation();
      const target = clickedElement;
      const rect = updateRect(target);
      setSelection({
        type: "element",
        label: getElementLabel(target),
        selector: getUniqueSelector(target),
        html: target.outerHTML.slice(0, 2600),
        placement: getElementPlacement(doc, target),
        rect,
      });
      setRegionRect(null);
      setDrawPoints([]);
      setHoverRect(null);
      setPanelOpen(true);
      window.setTimeout(() => promptRef.current?.focus(), 80);
    };

    doc.addEventListener("pointermove", handleMove, true);
    doc.addEventListener("pointerdown", handlePointerDown, true);
    doc.addEventListener("pointerup", finishMove, true);
    doc.addEventListener("pointercancel", cancelMove, true);
    doc.addEventListener("pointerleave", handleLeave, true);
    doc.addEventListener("wheel", handleIframeWheel, {
      capture: true,
      passive: false,
    });
    doc.addEventListener("click", handleClick, true);
    return () => {
      doc.removeEventListener("pointermove", handleMove, true);
      doc.removeEventListener("pointerdown", handlePointerDown, true);
      doc.removeEventListener("pointerup", finishMove, true);
      doc.removeEventListener("pointercancel", cancelMove, true);
      doc.removeEventListener("pointerleave", handleLeave, true);
      doc.removeEventListener("wheel", handleIframeWheel, true);
      doc.removeEventListener("click", handleClick, true);
      doc.body.style.userSelect = "";
      doc.body.style.touchAction = "";
    };
  }, [abortActiveFreeMove, canvasScale, isWorking, reportNavigationIssue, resetIframeInteractionStyles, setCanvasScaleAroundPoint, showToast, toolMode]);

  const refreshIframeWiring = useCallback(() => {
    iframeCleanupRef.current();
    iframeCleanupRef.current = wireIframe();
  }, [wireIframe]);

  useEffect(() => {
    refreshIframeWiring();
  }, [previewHtml, refreshIframeWiring]);

  useEffect(() => () => iframeCleanupRef.current(), []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, isWorking]);

  useEffect(() => {
    if (!projectMenuOpen) return;
    const handleOutsidePointer = (event: globalThis.PointerEvent) => {
      if (!projectMenuRef.current?.contains(event.target as Node)) {
        setProjectMenuOpen(false);
      }
    };
    const handleMenuKeydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setProjectMenuOpen(false);
        projectTriggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", handleOutsidePointer);
    window.addEventListener("keydown", handleMenuKeydown);
    return () => {
      document.removeEventListener("pointerdown", handleOutsidePointer);
      window.removeEventListener("keydown", handleMenuKeydown);
    };
  }, [projectMenuOpen]);

  useEffect(() => {
    if (!pendingProject) return;
    const handlePendingKeydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setPendingProject(null);
    };
    window.addEventListener("keydown", handlePendingKeydown);
    return () => window.removeEventListener("keydown", handlePendingKeydown);
  }, [pendingProject]);

  useEffect(() => {
    const handleKeydown = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editingText =
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "INPUT" ||
        target?.isContentEditable;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          if (!hasStagedMoves) redo();
        } else if (hasStagedMoves) {
          undoStagedMove();
        } else {
          undo();
        }
        return;
      }
      if (editingText) return;
      if (event.key.toLowerCase() === "p") activateTool("interact");
      if (event.key.toLowerCase() === "v") activateTool("select");
      if (event.key.toLowerCase() === "m") activateTool("move");
      if (event.key.toLowerCase() === "r") activateTool("region");
      if (event.key.toLowerCase() === "b") activateTool("draw");
      if (event.key === "/") {
        event.preventDefault();
        setPanelOpen(true);
        setPanelTab("chat");
        window.setTimeout(() => promptRef.current?.focus(), 60);
      }
      if (event.key === "Escape") clearSelection();
    };
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [activateTool, clearSelection, hasStagedMoves, redo, undo, undoStagedMove]);

  const pointFromEvent = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / canvasScale,
      y: (event.clientY - rect.top) / canvasScale,
    };
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (toolMode === "select" || toolMode === "move") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFromEvent(event);
    pointerActiveRef.current = true;
    pointerOriginRef.current = point;
    setHoverRect(null);
    setSelection(null);
    if (toolMode === "region") {
      setRegionRect({ x: point.x, y: point.y, width: 0, height: 0 });
      setDrawPoints([]);
    } else {
      setDrawPoints([point]);
      setRegionRect(null);
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointerActiveRef.current || toolMode === "select" || toolMode === "move") return;
    const point = pointFromEvent(event);
    if (toolMode === "region" && pointerOriginRef.current) {
      const origin = pointerOriginRef.current;
      setRegionRect({
        x: Math.min(origin.x, point.x),
        y: Math.min(origin.y, point.y),
        width: Math.abs(point.x - origin.x),
        height: Math.abs(point.y - origin.y),
      });
    } else if (toolMode === "draw") {
      setDrawPoints((points) => [...points, point]);
    }
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointerActiveRef.current) return;
    const origin = pointerOriginRef.current;
    const finalPoint = pointFromEvent(event);
    pointerActiveRef.current = false;
    pointerOriginRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);

    const iframe = iframeRef.current;
    const doc = iframe?.contentDocument;
    const iframeBounds = iframe?.getBoundingClientRect();
    const layerBounds = event.currentTarget.getBoundingClientRect();
    const toIframeRect = (rect: Rect) => ({
      ...rect,
      x:
        rect.x +
        (layerBounds.left - (iframeBounds?.left ?? layerBounds.left)) / canvasScale,
      y:
        rect.y +
        (layerBounds.top - (iframeBounds?.top ?? layerBounds.top)) / canvasScale,
    });
    const selectArea = (type: "region" | "drawing", rect: Rect) => {
      const iframeRect = toIframeRect(rect);
      const targets = doc ? getSelectionTargets(doc, iframeRect) : [];
      const placement = doc ? getSelectionPlacement(doc, iframeRect) : undefined;
      const primary = targets[0];
      setSelection({
        type,
        label: primary ? `${type === "region" ? "圈选区域" : "手绘标注"} · ${primary.label}` : type === "region" ? "圈选区域" : "手绘标注",
        selector: primary?.selector,
        html: primary?.html,
        targets,
        placement,
        rect,
      });
    };

    if (toolMode === "region" && origin) {
      const finalRect = {
        x: Math.min(origin.x, finalPoint.x),
        y: Math.min(origin.y, finalPoint.y),
        width: Math.abs(finalPoint.x - origin.x),
        height: Math.abs(finalPoint.y - origin.y),
      };
      setRegionRect(finalRect);
      if (finalRect.width > 12 && finalRect.height > 12) {
        selectArea("region", finalRect);
      }
    }
    if (toolMode === "draw") {
      const finalPoints = [...drawPoints, finalPoint];
      setDrawPoints(finalPoints);
      if (finalPoints.length > 2) {
        selectArea("drawing", rectFromPoints(finalPoints));
      }
    }
    setPanelOpen(true);
    setPanelTab("chat");
    window.setTimeout(() => promptRef.current?.focus(), 60);
  };

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const incoming = Array.from(files).slice(0, 4 - attachments.length);
      const next: Attachment[] = [];
      for (const file of incoming) {
        try {
          if (file.type.startsWith("image/")) {
            if (file.size > 4 * 1024 * 1024) {
              showToast(`${file.name} 超过 4 MB，已跳过`);
              continue;
            }
            next.push({
              id: makeId("image"),
              name: file.name,
              mimeType: file.type,
              kind: "image",
              data: await readFileAsDataUrl(file),
              sizeLabel: prettyBytes(file.size),
            });
          } else {
            if (file.size > 1024 * 1024) {
              showToast(`${file.name} 超过 1 MB，已跳过`);
              continue;
            }
            next.push({
              id: makeId("doc"),
              name: file.name,
              mimeType: file.type || "text/plain",
              kind: "document",
              text: (await readFileAsText(file)).slice(0, 120_000),
              sizeLabel: prettyBytes(file.size),
            });
          }
        } catch {
          showToast(`${file.name} 读取失败`);
        }
      }
      if (next.length) {
        setAttachments((items) => [...items, ...next].slice(0, 4));
        setPanelOpen(true);
        setPanelTab("chat");
      }
    },
    [attachments.length, showToast],
  );

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    void addFiles(event.dataTransfer.files);
  };

  const removeAttachment = (id: string) => {
    setAttachments((items) => items.filter((item) => item.id !== id));
  };

  const switchCollaborationMode = (mode: CollaborationMode) => {
    setCollaborationMode(mode);
    setPanelTab("chat");
    setPanelOpen(true);
    setPrompt("");
    promptHistoryIndexRef.current = null;
    promptHistoryDraftRef.current = "";
  };

  const executeAgentJob = useCallback(async (job: AgentJob) => {
    const sourceHtml = currentHtml;
    const finalInstruction = job.instruction;
    const requestRevision = documentRevisionRef.current;
    const selectedContext = job.selection;
    const sentAttachments = job.attachments;
    const prepared = prepareTransformHtml(currentHtml, selectedContext, finalInstruction);
    updateModeMessage(job.mode, job.messageId, {
      queueState: "running",
      detail:
        job.priority === "steer"
          ? "Steer · 正在优先跟进"
          : job.priority === "queued"
            ? "Queue · 正在执行"
            : undefined,
    });
    setActiveAgentJob(job);
    setIsWorking(true);

    try {
      if (job.mode === "chat") {
        let reply: string;
        if (job.config.protocol === "demo") {
          await new Promise((resolve) => window.setTimeout(resolve, 420));
          reply = selectedContext
            ? `可以。当前上下文是「${selectedContext.label}」。我们可以先讨论它的信息、视觉层级和交互目标；Chat 模式不会直接修改画布。`
            : "可以。我们可以从目标用户、信息层级、视觉方向或实现取舍开始讨论；Chat 模式不会直接修改画布。";
        } else {
          const response = await fetch("/api/transform", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              mode: "chat",
              config: job.config,
              html: sourceHtml,
              instruction: finalInstruction,
              selection: selectedContext,
              attachments: sentAttachments,
            }),
          });
          const payload = (await response.json()) as {
            reply?: string;
            error?: string;
          };
          if (!response.ok || !payload.reply) {
            throw new Error(payload.error || "模型没有返回可用的回复");
          }
          reply = payload.reply;
        }
        appendModeMessage(job.mode, {
          id: makeId("chat-assistant"),
          role: "assistant",
          text: reply,
        });
        return;
      }

      let result: CoworkResult;
      if (prepared.insertionRequested && !prepared.insertionExpected) {
        throw new Error("无法确定这个位置的安全插入边界。请缩小圈选范围，或直接选中目标容器后重试。");
      }
      if (job.config.protocol === "demo" && prepared.insertionRequested) {
        throw new Error("演示模型暂不生成新组件。请连接实际模型后重试。");
      }
      if (job.config.protocol === "demo") {
        await new Promise((resolve) => window.setTimeout(resolve, 620));
        const demoResult = applyDemoEdit(sourceHtml, finalInstruction, selectedContext);
        result = {
          status: "completed",
          ...demoResult,
          issues: [],
          suggestions: [],
        };
      } else {
        const requestTransform = async (requestInstruction: string) => {
          const response = await fetch("/api/transform", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              mode: "cowork",
              config: job.config,
              html: prepared.html,
              instruction: requestInstruction,
              selection: prepared.selection,
              attachments: sentAttachments,
            }),
          });
          const payload = (await response.json()) as {
            html?: string;
            summary?: string;
            error?: string;
            status?: CoworkStatus;
            updates?: string[];
            issues?: string[];
            suggestions?: CoworkSuggestion[];
          };
          if (!response.ok) {
            throw new Error(payload.error || "模型没有返回可用的 HTML");
          }
          const status = payload.status ?? "completed";
          const summary = payload.summary || "已根据描述更新页面";
          const report = {
            status,
            summary,
            updates: Array.isArray(payload.updates) && payload.updates.length
              ? payload.updates
              : status === "blocked"
                ? []
                : [summary],
            issues: Array.isArray(payload.issues) ? payload.issues : [],
            suggestions: Array.isArray(payload.suggestions) ? payload.suggestions : [],
          };
          if (status === "blocked") {
            return { ...report, html: "" } as CoworkResult;
          }
          if (!payload.html) {
            throw new Error("模型没有返回可用的 HTML");
          }
          const cleaned = cleanTransformHtml(
            payload.html,
            prepared.markerToken,
            prepared.insertionExpected,
            prepared.selection?.placement,
          );
          return {
            ...report,
            ...cleaned,
          } as CoworkResult;
        };

        result = await requestTransform(finalInstruction);
        if (result.status === "blocked") {
          appendModeMessage(job.mode, {
            id: makeId("assistant-blocked"),
            role: "assistant",
            text: "需要你确认下一步",
            detail: result.summary,
            report: result,
          });
          showToast("当前任务需要选择解决方案");
          return;
        }
        if (
          htmlIsUnchanged(result.html, prepared.baselineHtml) ||
          (prepared.insertionExpected && !result.insertionApplied)
        ) {
          const retryGuidance = prepared.insertionExpected
            ? "上一次返回没有产生可应用的定点修改。请务必把新增组件作为 placement.slotAnchor 元素的子节点，并保留该插槽及其属性，然后返回完整 HTML。"
            : prepared.selection?.anchors?.length
              ? "上一次返回没有产生实际差异。请在 selected context 的首个锚点内完成所述修改，并返回修改后的完整 HTML。"
              : "上一次返回没有产生实际差异。请完成所述修改，并返回修改后的完整 HTML。";
          result = await requestTransform(
            `${finalInstruction}\n\n${retryGuidance}`,
          );
        }
        if (result.status === "blocked") {
          appendModeMessage(job.mode, {
            id: makeId("assistant-blocked"),
            role: "assistant",
            text: "需要你确认下一步",
            detail: result.summary,
            report: result,
          });
          showToast("当前任务需要选择解决方案");
          return;
        }
        if (prepared.insertionExpected && !result.insertionApplied) {
          throw new Error("模型没有把组件放入圈选位置，已停止应用以避免出现在错误区域。");
        }
        if (htmlIsUnchanged(result.html, prepared.baselineHtml)) {
          throw new Error("模型连续两次返回了原页面。请把修改要求写得更具体后重试。");
        }
      }

      if (documentRevisionRef.current !== requestRevision) {
        throw new Error("生成期间画布已发生变化。已保留最新版本，本次 AI 结果未应用。");
      }
      commitHtml(result.html);
      appendModeMessage(job.mode, {
        id: makeId("assistant"),
        role: "assistant",
        text: result.status === "partial" ? "已完成可执行部分" : "更新已完成",
        detail: result.summary,
        report: result,
      });
      showToast(result.status === "partial" ? "已应用部分更新" : "页面已更新");
    } catch (error) {
      const message = error instanceof Error ? error.message : "请求失败，请检查模型连接";
      appendModeMessage(job.mode, {
        id: makeId("error"),
        role: "assistant",
        text: job.mode === "cowork" ? "这次没有应用修改" : "这次没有完成回复",
        detail: job.mode === "cowork" ? "画布保持原样" : message,
        error: true,
        report: job.mode === "cowork" ? failureReport(message, finalInstruction) : undefined,
      });
    } finally {
      updateModeMessage(job.mode, job.messageId, {
        queueState: undefined,
        detail: undefined,
      });
      setActiveAgentJob(null);
      setIsWorking(false);
    }
  }, [appendModeMessage, commitHtml, currentHtml, showToast, updateModeMessage]);

  useEffect(() => {
    if (isWorking || activeAgentJob || agentQueue.length === 0) return;
    const [nextJob, ...remainingJobs] = agentQueue;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setAgentQueue(remainingJobs);
      void executeAgentJob(nextJob);
    });
    return () => {
      cancelled = true;
    };
  }, [activeAgentJob, agentQueue, executeAgentJob, isWorking]);

  const queueAgentMessage = (priority: AgentJobPriority) => {
    if (hasStagedMoves && collaborationMode === "cowork") {
      showToast("请先确认或放弃移动草稿");
      return;
    }
    const instruction = prompt.trim();
    if (!instruction && !attachments.length) return;
    const finalInstruction = instruction || "请参考附件优化当前页面。";
    const jobId = makeId("agent-job");
    const messageId = makeId("user");
    const job: AgentJob = {
      id: jobId,
      messageId,
      mode: collaborationMode,
      instruction: finalInstruction,
      attachments,
      selection,
      priority,
      config: { ...modelConfig },
    };
    const modeHistory = promptHistoryRef.current[collaborationMode];
    if (modeHistory[modeHistory.length - 1] !== finalInstruction) {
      promptHistoryRef.current[collaborationMode] = [
        ...modeHistory,
        finalInstruction,
      ].slice(-50);
    }
    promptHistoryIndexRef.current = null;
    promptHistoryDraftRef.current = "";
    appendModeMessage(collaborationMode, {
      id: messageId,
      jobId,
      role: "user",
      text: finalInstruction,
      queueState:
        priority === "steer"
          ? "steer"
          : priority === "queued"
            ? "queued"
            : undefined,
      detail:
        priority === "steer"
          ? "Steer · 当前任务后优先"
          : priority === "queued"
            ? "Queue · 等待执行"
            : undefined,
    });
    setAgentQueue((jobs) =>
      priority === "steer" ? [job, ...jobs] : [...jobs, job],
    );
    setPrompt("");
    setAttachments([]);
    setProjectMenuOpen(false);
  };

  const removeQueuedJob = (jobId: string) => {
    const job = agentQueue.find((candidate) => candidate.id === jobId);
    if (!job) return;
    setAgentQueue((jobs) => jobs.filter((candidate) => candidate.id !== jobId));
    const setter = job.mode === "cowork" ? setCoworkMessages : setChatMessages;
    setter((items) => items.filter((item) => item.jobId !== jobId));
  };

  const handlePromptKeydown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      promptComposingRef.current ||
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229
    ) {
      return;
    }
    if (event.key === "ArrowUp") {
      const history = promptHistoryRef.current[collaborationMode];
      const beforeCursor = event.currentTarget.value.slice(
        0,
        event.currentTarget.selectionStart,
      );
      if (
        history.length > 0 &&
        event.currentTarget.selectionStart === event.currentTarget.selectionEnd &&
        !beforeCursor.includes("\n")
      ) {
        event.preventDefault();
        if (promptHistoryIndexRef.current === null) {
          promptHistoryDraftRef.current = prompt;
          promptHistoryIndexRef.current = history.length - 1;
        } else {
          promptHistoryIndexRef.current = Math.max(
            0,
            promptHistoryIndexRef.current - 1,
          );
        }
        const previousPrompt = history[promptHistoryIndexRef.current];
        setPrompt(previousPrompt);
        window.requestAnimationFrame(() => {
          const textarea = promptRef.current;
          if (textarea) {
            textarea.setSelectionRange(
              previousPrompt.length,
              previousPrompt.length,
            );
          }
        });
        return;
      }
    }
    if (
      event.key === "ArrowDown" &&
      promptHistoryIndexRef.current !== null &&
      event.currentTarget.selectionStart === event.currentTarget.selectionEnd &&
      !event.currentTarget.value
        .slice(event.currentTarget.selectionEnd)
        .includes("\n")
    ) {
      event.preventDefault();
      const history = promptHistoryRef.current[collaborationMode];
      const nextIndex = promptHistoryIndexRef.current + 1;
      const nextPrompt =
        nextIndex >= history.length
          ? promptHistoryDraftRef.current
          : history[nextIndex];
      promptHistoryIndexRef.current =
        nextIndex >= history.length ? null : nextIndex;
      setPrompt(nextPrompt);
      window.requestAnimationFrame(() => {
        const textarea = promptRef.current;
        if (textarea) {
          textarea.setSelectionRange(nextPrompt.length, nextPrompt.length);
        }
      });
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      queueAgentMessage(isWorking ? "queued" : "normal");
    }
  };

  const chooseProvider = (providerId: ProviderId) => {
    const selected = PROVIDERS.find((item) => item.id === providerId) ?? PROVIDERS[0];
    const baseUrl = desktopInfo
      ? selected.baseUrl.replace("host.docker.internal", "127.0.0.1")
      : selected.baseUrl;
    setDraftConfig({
      providerId: selected.id,
      protocol: selected.protocol,
      baseUrl,
      model: selected.model,
      apiKey: "",
    });
  };

  const openSettings = () => {
    setDraftConfig(modelConfig);
    setSettingsOpen(true);
  };

  const saveSettings = () => {
    if (draftConfig.protocol !== "demo" && (!draftConfig.baseUrl || !draftConfig.model)) {
      showToast("请填写节点地址和模型名称");
      return;
    }
    setModelConfig(draftConfig);
    setSettingsOpen(false);
    showToast(
      draftConfig.protocol === "demo"
        ? "已切换到演示模型"
        : `已连接 ${PROVIDERS.find((item) => item.id === draftConfig.providerId)?.name}`,
    );
  };

  const handleDesktopUpdate = async () => {
    const desktop = window.canvaslyDesktop;
    if (!desktop || !desktopUpdate) return;
    try {
      if (desktopUpdate.status === "available") {
        await desktop.downloadUpdate();
        return;
      }
      if (desktopUpdate.status === "downloaded") {
        if (hasAgentWork) {
          showToast("请等待当前 Agent 队列完成后再安装更新");
          return;
        }
        if (hasStagedMoves) {
          showToast("请先确认或放弃移动草稿，再安装更新");
          return;
        }
        if (desktopPersistenceError) {
          showToast("项目自动保存不可用，请先导出 HTML 再安装更新");
          return;
        }
        await desktop.saveProject(desktopSnapshot);
        await desktop.installUpdate();
        return;
      }
      await desktop.checkForUpdates();
    } catch (error) {
      const message = desktopErrorMessage(error);
      console.error("[Canvasly] Desktop update action failed", error);
      showToast(`更新操作失败：${message}`);
    }
  };

  const desktopUpdateButton = (() => {
    if (!desktopUpdate) return { label: "检查更新", disabled: true };
    switch (desktopUpdate.status) {
      case "checking":
        return { label: "检查中…", disabled: true };
      case "available":
        return {
          label: `下载 v${desktopUpdate.version ?? ""}`,
          disabled: false,
        };
      case "downloading":
        return {
          label: `下载中 ${Math.round(desktopUpdate.percent ?? 0)}%`,
          disabled: true,
        };
      case "downloaded":
        return { label: "重启并安装", disabled: false };
      case "unsupported":
        return { label: "仅安装版可更新", disabled: true };
      default:
        return { label: "检查更新", disabled: false };
    }
  })();

  const exportHtml = () => {
    if (hasStagedMoves) {
      showToast("请先确认或放弃移动草稿，再导出 HTML");
      return;
    }
    const blob = new Blob([currentHtml], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = exportFileName(projectName);
    anchor.click();
    URL.revokeObjectURL(url);
    setSavedHtml(currentHtml);
    showToast("HTML 已导出");
  };

  const copyCode = async () => {
    await navigator.clipboard.writeText(codeDraft);
    showToast("HTML 已复制");
  };

  const applyProjectReplacement = (replacement: ProjectReplacement) => {
    documentRevisionRef.current += 1;
    setAgentQueue([]);
    stagedMovesRef.current.clear();
    setStagedMoves([]);
    setFreeMoveSteps([]);
    setMovePreview(null);
    setSavedMoveHtml(null);
    setHistory([replacement.html]);
    setHistoryIndex(0);
    setCodeDraft(replacement.html);
    setProjectBaseline(replacement.html);
    setSavedHtml(replacement.html);
    setProjectName(replacement.name);
    setCoworkMessages([
      { ...INITIAL_COWORK_MESSAGES[0], detail: replacement.detail },
    ]);
    setChatMessages(INITIAL_CHAT_MESSAGES);
    setPrompt("");
    setAttachments([]);
    setPanelOpen(true);
    setPanelTab("chat");
    setProjectMenuOpen(false);
    setPendingProject(null);
    clearSelection();
    showToast(replacement.toast);
  };

  const requestProjectReplacement = (replacement: ProjectReplacement) => {
    if (hasAgentWork) {
      showToast("请等待当前 Agent 队列完成");
      return;
    }
    setProjectMenuOpen(false);
    if (hasUnsavedChanges) {
      setPendingProject(replacement);
      return;
    }
    applyProjectReplacement(replacement);
  };

  const createBlankProject = () => {
    requestProjectReplacement({
      html: BLANK_HTML,
      name: "未命名页面",
      detail: "空白 HTML 已准备好。描述你想创建的页面，或直接打开 HTML 源码开始编辑。",
      toast: "已新建空白页面",
    });
  };

  const openHtmlProject = async (file: File) => {
    if (hasAgentWork) {
      showToast("请等待当前 Agent 队列完成");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      showToast(`${file.name} 超过 2 MB，无法打开`);
      return;
    }
    try {
      const source = (await readFileAsText(file)).replace(/^\uFEFF/, "");
      if (hasAgentWorkRef.current) {
        showToast("文件已读取，但当前 Agent 队列仍在运行，请稍后重新打开");
        return;
      }
      if (!source.trim()) {
        showToast(`${file.name} 是空文件`);
        return;
      }
      const html = /<html\b/i.test(source)
        ? source
        : serializeDocument(new DOMParser().parseFromString(source, "text/html"));
      const name = projectNameFromFile(file.name);
      requestProjectReplacement({
        html,
        name,
        detail: `已打开 ${file.name}。现在可以聊天、圈选或直接修改源码。`,
        toast: `已打开 ${file.name}`,
      });
    } catch {
      showToast(`${file.name} 读取失败`);
    }
  };

  const resetProject = () => {
    if (hasAgentWork) {
      showToast("请等待当前 Agent 队列完成后再重置");
      return;
    }
    documentRevisionRef.current += 1;
    setAgentQueue([]);
    stagedMovesRef.current.clear();
    setStagedMoves([]);
    setFreeMoveSteps([]);
    setMovePreview(null);
    setSavedMoveHtml(null);
    setHistory([projectBaseline]);
    setHistoryIndex(0);
    setCodeDraft(projectBaseline);
    setCoworkMessages(INITIAL_COWORK_MESSAGES);
    setChatMessages(INITIAL_CHAT_MESSAGES);
    setPrompt("");
    setAttachments([]);
    clearSelection();
    showToast("已恢复项目的初始版本");
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="app-mark"><span /></span>
          <span className="app-name">Canvasly</span>
          <span className="app-edition">Studio</span>
        </div>

        <div className="project-switcher-wrap" ref={projectMenuRef}>
          <button
            ref={projectTriggerRef}
            className={`project-switcher ${projectMenuOpen ? "open" : ""}`}
            onClick={() => setProjectMenuOpen((open) => !open)}
            disabled={hasAgentWork}
            aria-expanded={projectMenuOpen}
            aria-controls="project-menu"
            type="button"
          >
            <span className="project-dot" />
            <span className="project-copy">
              <strong>{projectName}</strong>
              <small>{isWorking ? "AI 正在修改…" : hasUnsavedChanges ? "有未导出修改" : "当前标签页"}</small>
            </span>
            <ChevronDown aria-hidden="true" className="project-chevron" size={15} />
          </button>
          {projectMenuOpen && (
            <div className="project-menu" id="project-menu" aria-label="页面项目操作">
              <button onClick={createBlankProject} type="button">
                <span className="project-menu-icon"><FilePlus2 size={17} /></span>
                <span><strong>新建空白页面</strong><small>从最小 HTML 文档开始</small></span>
              </button>
              <button
                onClick={() => {
                  setProjectMenuOpen(false);
                  openHtmlInputRef.current?.click();
                }}
                type="button"
              >
                <span className="project-menu-icon"><FolderOpen size={17} /></span>
                <span><strong>打开 HTML 文件</strong><small>加载本机的 .html 或 .htm</small></span>
              </button>
            </div>
          )}
        </div>

        <div className="topbar-actions">
          <div className="history-actions">
            <button onClick={hasStagedMoves ? undoStagedMove : undo} disabled={hasStagedMoves ? !freeMoveSteps.length : !canUndo} aria-label="撤销" title="撤销 · ⌘Z" type="button"><Undo2 size={17} /></button>
            <button onClick={redo} disabled={hasStagedMoves || !canRedo} aria-label="重做" title="重做 · ⇧⌘Z" type="button"><Redo2 size={17} /></button>
          </div>
          <button className="ghost-action hide-on-small" onClick={resetProject} disabled={hasAgentWork} type="button"><RotateCcw size={15} />重置</button>
          {desktopInfo && desktopUpdate && (
            <button
              className={`icon-action desktop-update-shortcut ${desktopUpdate.status === "available" || desktopUpdate.status === "downloaded" ? "has-update" : ""}`}
              onClick={() => void handleDesktopUpdate()}
              disabled={desktopUpdateButton.disabled}
              aria-label={`桌面更新：${desktopUpdateButton.label}`}
              title={desktopUpdateButton.label}
              type="button"
            >
              {desktopUpdate.status === "checking" || desktopUpdate.status === "downloading"
                ? <Loader2 size={17} className="spin" />
                : <RefreshCw size={17} />}
            </button>
          )}
          <button className="ghost-action" onClick={openSettings} type="button">
            <span className="provider-mini" style={{ background: provider.color }} />
            <span className="hide-on-small">{provider.name}</span>
          </button>
          <button className="primary-action" onClick={exportHtml} type="button"><Download size={15} />导出 HTML</button>
          <button
            className="icon-action panel-toggle"
            onClick={() => setPanelOpen((open) => !open)}
            aria-label={panelOpen ? "收起 AI 面板" : "打开 AI 面板"}
            type="button"
          >
            {panelOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
          </button>
        </div>
      </header>

      <div className={`workspace ${panelOpen ? "" : "panel-collapsed"}`}>
        <aside className="tool-rail" aria-label="画布工具">
          <div className="tool-group">
            <ToolButton active={toolMode === "interact"} label="操作页面" shortcut="P" onClick={() => activateTool("interact")}><Hand size={18} /></ToolButton>
            <ToolButton active={toolMode === "select"} label="选择元素" shortcut="V" onClick={() => activateTool("select")}><MousePointer2 size={19} /></ToolButton>
            <ToolButton active={toolMode === "move"} disabled={isWorking || hasPendingCodeDraft} label="移动组件" shortcut="M" onClick={() => activateTool("move")}><Move size={18} /></ToolButton>
            <ToolButton active={toolMode === "region"} label="圈选区域" shortcut="R" onClick={() => activateTool("region")}><BoxSelect size={19} /></ToolButton>
            <ToolButton active={toolMode === "draw"} label="手绘标注" shortcut="B" onClick={() => activateTool("draw")}><Pencil size={18} /></ToolButton>
          </div>
          <span className="rail-divider" />
          <div className="tool-group">
            <button className="tool-button" onClick={() => imageInputRef.current?.click()} aria-label="上传参考图" title="上传参考图" type="button"><ImagePlus size={19} /></button>
            <button className="tool-button" onClick={() => { setPanelOpen(true); setPanelTab("code"); }} aria-label="查看 HTML" title="查看 HTML" type="button"><Code2 size={19} /></button>
          </div>
          <div className="rail-bottom">
            <button className="tool-button" onClick={openSettings} aria-label="模型设置" title="模型设置" type="button"><Settings2 size={19} /></button>
          </div>
        </aside>

        <section className="canvas-column">
          <div className="canvas-toolbar">
            <div className={`canvas-tool-state state-${toolMode}`}>
              <span className="tool-state-icon">
                {toolMode === "select" && <MousePointer2 size={14} />}
                {toolMode === "interact" && <Hand size={14} />}
                {toolMode === "move" && <Move size={14} />}
                {toolMode === "region" && <BoxSelect size={14} />}
                {toolMode === "draw" && <Pencil size={14} />}
              </span>
              <span>
                <strong>
                  {toolMode === "select" && "智能选择"}
                  {toolMode === "interact" && "操作页面"}
                  {toolMode === "move" && (isMovingElement ? "自由移动中" : hasStagedMoves ? "继续编排" : "自由移动")}
                  {toolMode === "region" && "区域定位"}
                  {toolMode === "draw" && "手绘意图"}
                </strong>
                <small>
                  {toolMode === "select" && "DOM 目标"}
                  {toolMode === "interact" && "点击与输入"}
                  {toolMode === "move" && (
                    isMovingElement && movePreview
                      ? `X ${Math.round(movePreview.x)} · Y ${Math.round(movePreview.y)}`
                      : hasStagedMoves
                        ? `${stagedMoves.length} 个组件待确认`
                        : "PPT 式定位"
                  )}
                  {toolMode === "region" && "范围上下文"}
                  {toolMode === "draw" && "视觉上下文"}
                </small>
              </span>
            </div>
            <div className="canvas-viewport-controls">
              <div className="device-tabs" aria-label="预览尺寸">
                <button className={device === "desktop" ? "active" : ""} onClick={() => changeDevice("desktop")} aria-label="桌面预览" type="button"><Monitor size={16} /></button>
                <button className={device === "tablet" ? "active" : ""} onClick={() => changeDevice("tablet")} aria-label="平板预览" type="button"><Tablet size={16} /></button>
                <button className={device === "mobile" ? "active" : ""} onClick={() => changeDevice("mobile")} aria-label="手机预览" type="button"><Smartphone size={16} /></button>
              </div>
              <span className="canvas-size">
                {deviceSize.width} × {deviceSize.height}
                <span className="canvas-zoom-controls" aria-label="画布缩放">
                  <button
                    onClick={() => setCanvasScaleAroundPoint(canvasScale - 0.1)}
                    disabled={canvasScale <= MIN_CANVAS_SCALE + 0.01}
                    aria-label="缩小画布"
                    title="缩小画布"
                    type="button"
                  ><Minus size={12} /></button>
                  <button
                    className={canvasIsFit ? "fit" : ""}
                    onClick={resetCanvasZoom}
                    aria-label={`适应画布，当前 ${canvasScalePercent}%`}
                    title="适应画布"
                    type="button"
                  ><span>{canvasScalePercent}%</span><Maximize2 size={10} /></button>
                  <button
                    onClick={() => setCanvasScaleAroundPoint(canvasScale + 0.1)}
                    disabled={canvasScale >= MAX_CANVAS_SCALE - 0.01}
                    aria-label="放大画布"
                    title="放大画布"
                    type="button"
                  ><Plus size={12} /></button>
                </span>
              </span>
            </div>
            <div className="mobile-history-actions" aria-label="版本操作">
              <button onClick={hasStagedMoves ? undoStagedMove : undo} disabled={hasStagedMoves ? !freeMoveSteps.length : !canUndo} aria-label="撤销" type="button"><Undo2 size={15} /></button>
              <button onClick={redo} disabled={hasStagedMoves || !canRedo} aria-label="重做" type="button"><Redo2 size={15} /></button>
            </div>
            <div className={`canvas-context-state ${selection ? "active" : ""}`}>
              <Sparkles size={13} />
              <span>{selection ? selection.label : "DOM 上下文已同步"}</span>
            </div>
          </div>

          <div
            ref={canvasScrollerRef}
            className="canvas-scroller"
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleDrop}
          >
            <div
              className={`device-stage ${canvasIsFit ? "" : "user-zoomed"}`}
              style={{
                width: deviceSize.width * canvasScale,
                height: deviceSize.height * canvasScale,
              }}
            >
              <div
                className={`device-frame tool-${toolMode}`}
                style={{
                  width: deviceSize.width,
                  height: deviceSize.height,
                  transform: `scale(${canvasScale})`,
                }}
              >
                <iframe
                  ref={iframeRef}
                  srcDoc={previewHtml}
                  title="HTML 页面预览"
                  sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                  referrerPolicy="no-referrer"
                  onLoad={refreshIframeWiring}
                />
                <div
                  className="interaction-layer"
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerUp}
                >
                  {drawPoints.length > 1 && (
                    <svg className="draw-overlay" aria-hidden="true">
                      <path d={toSvgPath(drawPoints)} />
                    </svg>
                  )}
                </div>

                {hoverRect && (toolMode === "select" || toolMode === "move") && !selection && (
                  <div className="hover-outline" style={{ left: hoverRect.x, top: hoverRect.y, width: hoverRect.width, height: hoverRect.height }} />
                )}
                {selection?.type === "element" && !isMovingElement && (
                  <div className={`selection-outline ${isMovingElement ? "moving" : ""}`} style={{ left: selection.rect.x, top: selection.rect.y, width: selection.rect.width, height: selection.rect.height }}>
                    <span>{selection.label}</span>
                  </div>
                )}
                {regionRect && (
                  <div className="region-outline" style={{ left: regionRect.x, top: regionRect.y, width: regionRect.width, height: regionRect.height }}>
                    {selection?.type === "region" && <span>编辑这个区域</span>}
                  </div>
                )}
              </div>
            </div>
          </div>

          {hasStagedMoves && (
            <div className="move-batch-bar" role="status" aria-live="polite">
              <div className="move-batch-summary">
                <span className="move-batch-icon"><Move size={15} /></span>
                <span>
                  <strong>移动草稿</strong>
                  <small>{stagedMoves.length} 个组件 · {freeMoveSteps.length} 次调整</small>
                </span>
              </div>
              <div className="move-batch-actions">
                <button onClick={undoStagedMove} disabled={!freeMoveSteps.length} type="button"><Undo2 size={14} />撤销上一步</button>
                <button onClick={discardStagedMoves} type="button"><X size={14} />放弃</button>
                <button className="confirm" onClick={confirmStagedMoves} type="button"><Check size={14} />确认并渲染</button>
              </div>
            </div>
          )}

          {!hasStagedMoves && savedMoveHtml === currentHtml && (
            <div className="move-batch-bar saved" role="status">
              <div className="move-batch-summary">
                <span className="move-batch-icon"><Check size={15} /></span>
                <span><strong>位置已渲染</strong><small>已写入 HTML 和版本历史</small></span>
              </div>
              <div className="move-batch-actions">
                <button onClick={undoSavedMove} type="button"><Undo2 size={14} />撤销移动</button>
                <button onClick={() => setSavedMoveHtml(null)} aria-label="关闭移动提示" type="button"><X size={14} /></button>
              </div>
            </div>
          )}

          <div className="canvas-statusbar">
            <span><span className="status-dot" />{isWorking ? "Agent 正在生成" : "画布已同步"}</span>
            <span className="status-meta"><strong>{device}</strong><span>{historyIndex + 1} / {history.length} 版本</span></span>
          </div>
        </section>

        <aside className={`ai-panel ${panelOpen ? "open" : ""}`}>
          <div className="panel-header">
            <div className="collaboration-switch" role="group" aria-label="协作模式">
              <button
                className={collaborationMode === "cowork" ? "active" : ""}
                onClick={() => switchCollaborationMode("cowork")}
                type="button"
              >
                <Wand2 size={14} />Cowork
              </button>
              <button
                className={collaborationMode === "chat" ? "active" : ""}
                onClick={() => switchCollaborationMode("chat")}
                type="button"
              >
                <MessageSquare size={14} />Chat
              </button>
            </div>
            <div className="panel-header-actions">
              {collaborationMode === "cowork" && (
                <button
                  className={`code-view-toggle ${panelTab === "code" ? "active" : ""}`}
                  onClick={() => setPanelTab((tab) => tab === "code" ? "chat" : "code")}
                  aria-label={panelTab === "code" ? "返回 Cowork" : "查看 HTML"}
                  title={panelTab === "code" ? "返回 Cowork" : "查看 HTML"}
                  type="button"
                >
                  <Code2 size={16} />
                </button>
              )}
              <button className="panel-close" onClick={() => setPanelOpen(false)} aria-label="关闭面板" type="button"><X size={17} /></button>
            </div>
          </div>

          {panelTab === "chat" ? (
            <>
              <div className="chat-scroll">
                <div className="context-banner">
                  <div className="ai-orb"><Sparkles size={15} /></div>
                  <div>
                    <span className="agent-label"><i />Canvasly {collaborationMode === "cowork" ? "Cowork" : "Chat"}</span>
                    <strong>
                      {collaborationMode === "cowork"
                        ? "画布上下文已同步"
                        : "对话模式 · 不修改画布"}
                    </strong>
                  </div>
                </div>

                <div className="message-list">
                  {messages.map((message) => (
                    <article key={message.id} className={`message ${message.role} ${message.error ? "error" : ""}`}>
                      {message.role === "assistant" && <span className="message-avatar"><Wand2 size={14} /></span>}
                      <div className="message-bubble">
                        <p>{message.text}</p>
                        {message.detail && <span>{message.detail}</span>}
                        {message.report && (
                          <CoworkReportDetails
                            report={message.report}
                            onChoose={chooseCoworkSuggestion}
                          />
                        )}
                        {collaborationMode === "cowork" && message.role === "assistant" && !message.id.endsWith("welcome") && !message.error && message.report?.status !== "blocked" && (
                          <button onClick={undo} disabled={!canUndo} type="button"><Undo2 size={12} />撤销这次修改</button>
                        )}
                      </div>
                    </article>
                  ))}
                  {isWorking && activeAgentJob?.mode === collaborationMode && (
                    <article className="message assistant working">
                      <span className="message-avatar"><Wand2 size={14} /></span>
                      <div className="message-bubble"><p><Loader2 className="spin" size={14} />{collaborationMode === "cowork" ? "正在理解页面并生成修改…" : "正在思考并组织回复…"}</p></div>
                    </article>
                  )}
                  <div ref={chatEndRef} />
                </div>

                {messages.length < 3 && (
                  <div className="suggestions">
                    <span>试试这样说</span>
                    <div>
                      {(collaborationMode === "cowork" ? PROMPT_SUGGESTIONS : CHAT_SUGGESTIONS).map((suggestion) => (
                        <button key={suggestion} onClick={() => { setPrompt(suggestion); promptRef.current?.focus(); }} type="button">{suggestion}</button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="composer-wrap">
                {(activeAgentJob?.mode === collaborationMode ||
                  agentQueue.some((job) => job.mode === collaborationMode)) && (
                  <div className="agent-followups">
                    {activeAgentJob?.mode === collaborationMode && (
                      <div className="active-agent-job">
                        <Loader2 className="spin" size={13} />
                        <span>
                          <strong>正在处理</strong>
                          <small>{activeAgentJob.instruction}</small>
                        </span>
                      </div>
                    )}
                    {agentQueue
                      .filter((job) => job.mode === collaborationMode)
                      .map((job) => (
                        <div className={`queued-agent-job ${job.priority}`} key={job.id}>
                          {job.priority === "steer" ? <Route size={13} /> : <ListPlus size={13} />}
                          <span>
                            <strong>{job.priority === "steer" ? "Steer" : `Queue ${agentQueue.indexOf(job) + 1}`}</strong>
                            <small>{job.instruction}</small>
                          </span>
                          <button onClick={() => removeQueuedJob(job.id)} aria-label={`移除 ${job.instruction}`} type="button"><X size={12} /></button>
                        </div>
                      ))}
                  </div>
                )}
                {selection && (
                  <div className="selection-chip">
                    {selection.type === "element" ? <MousePointer2 size={13} /> : selection.type === "region" ? <BoxSelect size={13} /> : <Pencil size={13} />}
                    <span>{selection.label}</span>
                    <button onClick={clearSelection} aria-label="移除选择" type="button"><X size={13} /></button>
                  </div>
                )}
                {!!attachments.length && (
                  <div className="attachment-list">
                    {attachments.map((attachment) => (
                      <div className="attachment-chip" key={attachment.id}>
                        {attachment.kind === "image" && attachment.data ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={attachment.data} alt="" />
                        ) : <FileText size={16} />}
                        <span><strong>{attachment.name}</strong><small>{attachment.sizeLabel}</small></span>
                        <button onClick={() => removeAttachment(attachment.id)} aria-label={`移除 ${attachment.name}`} type="button"><X size={12} /></button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="composer">
                  <textarea
                    ref={promptRef}
                    value={prompt}
                    onChange={(event) => {
                      setPrompt(event.target.value);
                      promptHistoryIndexRef.current = null;
                      promptHistoryDraftRef.current = "";
                    }}
                    onCompositionStart={() => {
                      promptComposingRef.current = true;
                    }}
                    onCompositionEnd={() => {
                      promptComposingRef.current = false;
                    }}
                    onBlur={() => {
                      promptComposingRef.current = false;
                    }}
                    onKeyDown={handlePromptKeydown}
                    placeholder={
                      collaborationMode === "chat"
                        ? selection
                          ? "聊聊当前选择，或询问设计建议…"
                          : "讨论页面、内容、方向或实现取舍…"
                        : selection
                          ? "描述你希望如何修改这里…"
                          : "描述你想要的页面修改…"
                    }
                    rows={3}
                  />
                  <div className="composer-actions">
                    <div>
                      <button onClick={() => fileInputRef.current?.click()} aria-label="添加文档" title="添加文本、Markdown、HTML 或 CSS" type="button"><Paperclip size={17} /></button>
                      <button onClick={() => imageInputRef.current?.click()} aria-label="添加参考图" title="添加参考图" type="button"><ImageIcon size={17} /></button>
                    </div>
                    {isWorking ? (
                      <div className="followup-actions">
                        <button
                          className="queue-button"
                          onClick={() => queueAgentMessage("queued")}
                          disabled={(collaborationMode === "cowork" && hasStagedMoves) || (!prompt.trim() && !attachments.length)}
                          aria-label="加入队列"
                          title="当前任务完成后按顺序执行"
                          type="button"
                        >
                          <ListPlus size={15} /><span>Queue</span>
                        </button>
                        <button
                          className="steer-button"
                          onClick={() => queueAgentMessage("steer")}
                          disabled={(collaborationMode === "cowork" && hasStagedMoves) || (!prompt.trim() && !attachments.length)}
                          aria-label="优先跟进"
                          title="当前任务完成后优先执行"
                          type="button"
                        >
                          <Route size={15} /><span>Steer</span>
                        </button>
                      </div>
                    ) : (
                      <button className="send-button" onClick={() => queueAgentMessage("normal")} disabled={(collaborationMode === "cowork" && hasStagedMoves) || (!prompt.trim() && !attachments.length)} aria-label="发送" type="button">
                        <Send size={17} />
                      </button>
                    )}
                  </div>
                </div>
                <div className="composer-meta">
                  <button onClick={openSettings} type="button">
                    <span className="provider-mini" style={{ background: provider.color }} />
                    {provider.name}<ChevronDown size={12} />
                  </button>
                  <span>{collaborationMode === "cowork" ? "Cowork" : "Chat"} · {selection ? "当前目标" : "完整页面"}</span>
                </div>
              </div>
            </>
          ) : (
            <div className="code-panel">
              <div className="code-toolbar">
                <div><span className="code-language">HTML</span><span>{codeDraft.length.toLocaleString()} 字符</span></div>
                <button onClick={() => void copyCode()} type="button"><Copy size={14} />复制</button>
              </div>
              <textarea
                value={codeDraft}
                onChange={(event) => {
                  documentRevisionRef.current += 1;
                  activateTool("select");
                  setCodeDraft(event.target.value);
                }}
                spellCheck={false}
                aria-label="HTML 源码"
                disabled={hasStagedMoves}
              />
              <div className="code-footer">
                <button className="ghost-code" onClick={() => setCodeDraft(currentHtml)} type="button"><Trash2 size={14} />放弃修改</button>
                <button className="apply-code" onClick={() => { if (hasStagedMoves) { showToast("请先确认或放弃移动草稿"); return; } commitHtml(codeDraft); showToast("代码已应用"); }} disabled={hasStagedMoves || codeDraft === currentHtml} type="button"><Check size={14} />应用到画布</button>
              </div>
            </div>
          )}
        </aside>
      </div>

      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        multiple
        accept=".txt,.md,.html,.htm,.css,.json,.js,.jsx,.ts,.tsx,text/*"
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          if (event.target.files) void addFiles(event.target.files);
          event.target.value = "";
        }}
      />
      <input
        ref={imageInputRef}
        className="visually-hidden"
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          if (event.target.files) void addFiles(event.target.files);
          event.target.value = "";
        }}
      />
      <input
        ref={openHtmlInputRef}
        className="visually-hidden"
        type="file"
        accept=".html,.htm,.xhtml,text/html,application/xhtml+xml"
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const file = event.target.files?.[0];
          if (file) void openHtmlProject(file);
          event.target.value = "";
        }}
      />

      {settingsOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
          <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="model-settings-title">
            <header>
              <div><span className="modal-icon"><Settings2 size={18} /></span><div><h2 id="model-settings-title">连接你的模型</h2><p>选择服务，或填入任意兼容节点。</p></div></div>
              <button onClick={() => setSettingsOpen(false)} aria-label="关闭设置" type="button"><X size={18} /></button>
            </header>

            <div className="settings-body">
              <div className="provider-grid">
                {PROVIDERS.map((item) => (
                  <button
                    key={item.id}
                    className={draftConfig.providerId === item.id ? "active" : ""}
                    onClick={() => chooseProvider(item.id)}
                    type="button"
                  >
                    <span className="provider-logo" style={{ background: item.color }}>{item.name.slice(0, 1)}</span>
                    <span><strong>{item.name}</strong><small>{item.label}</small></span>
                    {draftConfig.providerId === item.id && <Check size={14} />}
                  </button>
                ))}
              </div>

              <div className="provider-description">
                <Sparkles size={15} />
                {PROVIDERS.find((item) => item.id === draftConfig.providerId)?.description}
              </div>

              {draftConfig.protocol !== "demo" && (
                <div className="connection-fields">
                  {draftConfig.providerId === "custom" && (
                    <div className="protocol-field">
                      <span>请求协议 <small>Endpoint API</small></span>
                      <div className="protocol-options" role="group" aria-label="自定义节点请求协议">
                        <button
                          className={draftConfig.protocol === "openai-responses" ? "active" : ""}
                          onClick={() => setDraftConfig((config) => ({ ...config, protocol: "openai-responses" }))}
                          type="button"
                        >
                          Responses API
                        </button>
                        <button
                          className={draftConfig.protocol === "openai-chat" ? "active" : ""}
                          onClick={() => setDraftConfig((config) => ({ ...config, protocol: "openai-chat" }))}
                          type="button"
                        >
                          Chat Completions
                        </button>
                      </div>
                    </div>
                  )}
                  <label>
                    <span>节点地址 <small>Base URL</small></span>
                    <input value={draftConfig.baseUrl} onChange={(event) => setDraftConfig((config) => ({ ...config, baseUrl: event.target.value }))} placeholder="https://api.example.com/v1" autoComplete="url" />
                  </label>
                  <label>
                    <span>模型名称 <small>Model</small></span>
                    <input value={draftConfig.model} onChange={(event) => setDraftConfig((config) => ({ ...config, model: event.target.value }))} placeholder="model-name" autoComplete="off" />
                  </label>
                  <label>
                    <span>API 密钥 <small>仅保留在当前会话</small></span>
                    <input type="password" value={draftConfig.apiKey} onChange={(event) => setDraftConfig((config) => ({ ...config, apiKey: event.target.value }))} placeholder={PROVIDERS.find((item) => item.id === draftConfig.providerId)?.keyPlaceholder} autoComplete="off" />
                  </label>
                  {(draftConfig.providerId === "local" || draftConfig.providerId === "copilot" || draftConfig.providerId === "custom") && (
                    <div className="local-note">
                      <Monitor size={15} />
                      {desktopInfo ? (
                        <>桌面版使用 <code>127.0.0.1</code> 连接这台电脑上的模型服务。</>
                      ) : (
                        <>本机开发可使用 <code>127.0.0.1</code>；Docker 中请用 <code>host.docker.internal</code> 指向宿主机。</>
                      )}
                    </div>
                  )}
                </div>
              )}

              {desktopInfo && desktopUpdate && (
                <section className="desktop-update-card" aria-labelledby="desktop-update-title">
                  <div className="desktop-update-heading">
                    <span className="desktop-update-icon"><RefreshCw size={16} /></span>
                    <div>
                      <strong id="desktop-update-title">Canvasly 桌面版</strong>
                      <small>当前版本 v{desktopInfo.version}</small>
                    </div>
                    <button
                      className="desktop-update-button"
                      onClick={() => void handleDesktopUpdate()}
                      disabled={desktopUpdateButton.disabled}
                      type="button"
                    >
                      {(desktopUpdate.status === "checking" || desktopUpdate.status === "downloading") && <Loader2 size={13} className="spin" />}
                      {desktopUpdateButton.label}
                    </button>
                  </div>
                  <p className={`desktop-update-message ${desktopUpdate.status === "error" ? "error" : ""}`} aria-live="polite">
                    {desktopUpdate.message}
                  </p>
                  {desktopUpdate.status === "downloading" && (
                    <div className="desktop-update-progress">
                      <span style={{ width: `${Math.max(0, Math.min(100, desktopUpdate.percent ?? 0))}%` }} />
                    </div>
                  )}
                  {desktopUpdate.status === "downloading" && desktopUpdate.total !== undefined && (
                    <small className="desktop-update-size">
                      {formatDesktopBytes(desktopUpdate.transferred)} / {formatDesktopBytes(desktopUpdate.total)}
                      {desktopUpdate.bytesPerSecond ? ` · ${formatDesktopBytes(desktopUpdate.bytesPerSecond)}/s` : ""}
                    </small>
                  )}
                  {desktopUpdate.releaseNotes && (
                    <details className="desktop-release-notes">
                      <summary>查看更新说明</summary>
                      <p>{desktopUpdate.releaseNotes}</p>
                    </details>
                  )}
                  <small className="desktop-save-state">
                    {desktopPersistenceError
                      ? `项目自动保存不可用：${desktopPersistenceError}`
                      : `项目与版本历史已自动保存在此电脑${desktopSavedAt ? ` · ${new Date(desktopSavedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}`
                    }
                    ；API 密钥不会保存
                  </small>
                </section>
              )}
            </div>

            <footer>
              <span><span className="privacy-dot" />密钥不会写入浏览器存储或项目文件</span>
              <div><button className="modal-cancel" onClick={() => setSettingsOpen(false)} type="button">取消</button><button className="modal-save" onClick={saveSettings} type="button">保存连接</button></div>
            </footer>
          </section>
        </div>
      )}

      {pendingProject && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPendingProject(null); }}>
          <section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="replace-project-title" aria-describedby="replace-project-description">
            <span className="confirm-modal-icon"><FilePlus2 size={20} /></span>
            <h2 id="replace-project-title">放弃未导出的修改？</h2>
            <p id="replace-project-description">
              当前页面“{projectName}”还有未导出的内容。继续后，这些修改将从当前标签页中移除。
            </p>
            <div className="confirm-actions">
              <button className="modal-cancel" onClick={() => setPendingProject(null)} autoFocus type="button">继续编辑</button>
              <button className="modal-save" onClick={() => applyProjectReplacement(pendingProject)} type="button">放弃并继续</button>
            </div>
          </section>
        </div>
      )}

      {toast && <div className="toast" role="status" aria-live="polite"><Check size={15} />{toast}</div>}
    </main>
  );
}
