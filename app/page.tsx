"use client";

import {
  BoxSelect,
  Check,
  ChevronDown,
  Code2,
  Copy,
  Download,
  FilePlus2,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  ImagePlus,
  Loader2,
  MessageSquare,
  Monitor,
  MousePointer2,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Pencil,
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
} from "lucide-react";
import {
  useCallback,
  useEffect,
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

type ToolMode = "select" | "region" | "draw";
type DeviceMode = "desktop" | "tablet" | "mobile";
type PanelTab = "chat" | "code";

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

type Attachment = {
  id: string;
  name: string;
  mimeType: string;
  kind: "image" | "document";
  data?: string;
  text?: string;
  sizeLabel: string;
};

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  detail?: string;
  error?: boolean;
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

const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    text: "想改哪里？选中元素、圈出区域，或直接在画布上画一笔，然后告诉我你的想法。",
    detail: "当前为演示模型，你可以先体验完整编辑流程。",
  },
];

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
  const noScripts = source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, "");
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; font-src data:; media-src data: https:;">`;
  if (/<head\b[^>]*>/i.test(noScripts)) {
    return noScripts.replace(/<head\b[^>]*>/i, (head) => `${head}${csp}`);
  }
  if (/<html\b[^>]*>/i.test(noScripts)) {
    return noScripts.replace(/<html\b[^>]*>/i, (html) => `${html}<head>${csp}</head>`);
  }
  const doctype = noScripts.match(/^\s*<!doctype\b[^>]*>/i)?.[0];
  if (doctype) {
    return noScripts.replace(doctype, `${doctype}\n<head>${csp}</head>`);
  }
  return `<head>${csp}</head>${noScripts}`;
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
  };
}

function ToolButton({
  active,
  label,
  shortcut,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  shortcut: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`tool-button ${active ? "active" : ""}`}
      onClick={onClick}
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
  const [panelOpen, setPanelOpen] = useState(true);
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
  const [regionRect, setRegionRect] = useState<Rect | null>(null);
  const [drawPoints, setDrawPoints] = useState<Point[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES);
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isWorking, setIsWorking] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [modelConfig, setModelConfig] = useState<ModelConfig>({
    providerId: initialProvider.id,
    protocol: initialProvider.protocol,
    baseUrl: initialProvider.baseUrl,
    model: initialProvider.model,
    apiKey: "",
  });
  const [draftConfig, setDraftConfig] = useState<ModelConfig>(modelConfig);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const openHtmlInputRef = useRef<HTMLInputElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const projectTriggerRef = useRef<HTMLButtonElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const pointerOriginRef = useRef<Point | null>(null);
  const pointerActiveRef = useRef(false);

  const currentHtml = history[historyIndex];
  const previewHtml = useMemo(() => safePreviewHtml(currentHtml), [currentHtml]);
  const provider =
    PROVIDERS.find((item) => item.id === modelConfig.providerId) ?? PROVIDERS[0];
  const deviceSize = DEVICE_SIZES[device];
  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < history.length - 1;
  const hasUnsavedChanges = currentHtml !== savedHtml || codeDraft !== currentHtml;

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  const commitHtml = useCallback(
    (nextHtml: string) => {
      if (!nextHtml.trim() || nextHtml === currentHtml) return;
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
    const nextIndex = historyIndex - 1;
    setHistoryIndex(nextIndex);
    setCodeDraft(history[nextIndex]);
    setSelection(null);
  }, [canUndo, history, historyIndex]);

  const redo = useCallback(() => {
    if (!canRedo) return;
    const nextIndex = historyIndex + 1;
    setHistoryIndex(nextIndex);
    setCodeDraft(history[nextIndex]);
    setSelection(null);
  }, [canRedo, history, historyIndex]);

  const clearSelection = useCallback(() => {
    setSelection(null);
    setRegionRect(null);
    setDrawPoints([]);
    setHoverRect(null);
  }, []);

  const wireIframe = useCallback(() => {
    const iframe = iframeRef.current;
    const doc = iframe?.contentDocument;
    if (!iframe || !doc) return () => undefined;

    doc.body.style.cursor = toolMode === "select" ? "default" : "crosshair";
    const ElementCtor = doc.defaultView?.Element;

    const updateRect = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const iframeRect = iframe.getBoundingClientRect();
      const frameRect = iframe.parentElement?.getBoundingClientRect() ?? iframeRect;
      return {
        x: rect.left + iframeRect.left - frameRect.left,
        y: rect.top + iframeRect.top - frameRect.top,
        width: rect.width,
        height: rect.height,
      };
    };

    const handleMove = (event: Event) => {
      if (toolMode !== "select" || !ElementCtor || !(event.target instanceof ElementCtor)) {
        return;
      }
      setHoverRect(updateRect(event.target));
    };

    const handleLeave = () => setHoverRect(null);

    const handleClick = (event: Event) => {
      if (toolMode !== "select" || !ElementCtor || !(event.target instanceof ElementCtor)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const target = event.target;
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
    doc.addEventListener("pointerleave", handleLeave, true);
    doc.addEventListener("click", handleClick, true);
    return () => {
      doc.removeEventListener("pointermove", handleMove, true);
      doc.removeEventListener("pointerleave", handleLeave, true);
      doc.removeEventListener("click", handleClick, true);
    };
  }, [toolMode]);

  useEffect(() => wireIframe(), [previewHtml, wireIframe]);

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
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (editingText) return;
      if (event.key.toLowerCase() === "v") setToolMode("select");
      if (event.key.toLowerCase() === "r") setToolMode("region");
      if (event.key.toLowerCase() === "b") setToolMode("draw");
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
  }, [clearSelection, redo, undo]);

  const pointFromEvent = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (toolMode === "select") return;
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
    if (!pointerActiveRef.current || toolMode === "select") return;
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
      x: rect.x + layerBounds.left - (iframeBounds?.left ?? layerBounds.left),
      y: rect.y + layerBounds.top - (iframeBounds?.top ?? layerBounds.top),
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

  const sendPrompt = async () => {
    const instruction = prompt.trim();
    if ((!instruction && !attachments.length) || isWorking) return;
    const finalInstruction = instruction || "请参考附件优化当前页面。";
    const selectedContext = selection;
    const sentAttachments = attachments;
    const prepared = prepareTransformHtml(currentHtml, selectedContext, finalInstruction);

    setMessages((items) => [
      ...items,
      { id: makeId("user"), role: "user", text: finalInstruction },
    ]);
    setPrompt("");
    setAttachments([]);
    setProjectMenuOpen(false);
    setIsWorking(true);

    try {
      let result: { html: string; summary: string; insertionApplied?: boolean };
      if (prepared.insertionRequested && !prepared.insertionExpected) {
        throw new Error("无法确定这个位置的安全插入边界。请缩小圈选范围，或直接选中目标容器后重试。");
      }
      if (modelConfig.protocol === "demo" && prepared.insertionRequested) {
        throw new Error("演示模型暂不生成新组件。请连接实际模型后重试。");
      }
      if (modelConfig.protocol === "demo") {
        await new Promise((resolve) => window.setTimeout(resolve, 620));
        result = applyDemoEdit(currentHtml, finalInstruction, selectedContext);
      } else {
        const requestTransform = async (requestInstruction: string) => {
          const response = await fetch("/api/transform", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              config: modelConfig,
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
          };
          if (!response.ok || !payload.html) {
            throw new Error(payload.error || "模型没有返回可用的 HTML");
          }
          const cleaned = cleanTransformHtml(
            payload.html,
            prepared.markerToken,
            prepared.insertionExpected,
            prepared.selection?.placement,
          );
          return {
            ...cleaned,
            summary: payload.summary || "已根据描述更新页面",
          };
        };

        result = await requestTransform(finalInstruction);
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
        if (prepared.insertionExpected && !result.insertionApplied) {
          throw new Error("模型没有把组件放入圈选位置，已停止应用以避免出现在错误区域。");
        }
        if (htmlIsUnchanged(result.html, prepared.baselineHtml)) {
          throw new Error("模型连续两次返回了原页面。请把修改要求写得更具体后重试。");
        }
      }

      commitHtml(result.html);
      setMessages((items) => [
        ...items,
        {
          id: makeId("assistant"),
          role: "assistant",
          text: "修改完成",
          detail: result.summary,
        },
      ]);
      showToast("页面已更新");
    } catch (error) {
      const message = error instanceof Error ? error.message : "请求失败，请检查模型连接";
      setMessages((items) => [
        ...items,
        {
          id: makeId("error"),
          role: "assistant",
          text: "这次没有应用修改",
          detail: message,
          error: true,
        },
      ]);
    } finally {
      setIsWorking(false);
    }
  };

  const handlePromptKeydown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendPrompt();
    }
  };

  const chooseProvider = (providerId: ProviderId) => {
    const selected = PROVIDERS.find((item) => item.id === providerId) ?? PROVIDERS[0];
    setDraftConfig({
      providerId: selected.id,
      protocol: selected.protocol,
      baseUrl: selected.baseUrl,
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

  const exportHtml = () => {
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
    setHistory([replacement.html]);
    setHistoryIndex(0);
    setCodeDraft(replacement.html);
    setProjectBaseline(replacement.html);
    setSavedHtml(replacement.html);
    setProjectName(replacement.name);
    setMessages([{ ...INITIAL_MESSAGES[0], detail: replacement.detail }]);
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
    if (isWorking) {
      showToast("请等待当前 AI 修改完成");
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
    if (isWorking) {
      showToast("请等待当前 AI 修改完成");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      showToast(`${file.name} 超过 2 MB，无法打开`);
      return;
    }
    try {
      const source = (await readFileAsText(file)).replace(/^\uFEFF/, "");
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
    setHistory([projectBaseline]);
    setHistoryIndex(0);
    setCodeDraft(projectBaseline);
    setMessages(INITIAL_MESSAGES);
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
        </div>

        <div className="project-switcher-wrap" ref={projectMenuRef}>
          <button
            ref={projectTriggerRef}
            className={`project-switcher ${projectMenuOpen ? "open" : ""}`}
            onClick={() => setProjectMenuOpen((open) => !open)}
            disabled={isWorking}
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
            <button onClick={undo} disabled={!canUndo} aria-label="撤销" title="撤销 · ⌘Z" type="button"><Undo2 size={17} /></button>
            <button onClick={redo} disabled={!canRedo} aria-label="重做" title="重做 · ⇧⌘Z" type="button"><Redo2 size={17} /></button>
          </div>
          <button className="ghost-action hide-on-small" onClick={resetProject} type="button"><RotateCcw size={15} />重置</button>
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
            <ToolButton active={toolMode === "select"} label="选择元素" shortcut="V" onClick={() => setToolMode("select")}><MousePointer2 size={19} /></ToolButton>
            <ToolButton active={toolMode === "region"} label="圈选区域" shortcut="R" onClick={() => setToolMode("region")}><BoxSelect size={19} /></ToolButton>
            <ToolButton active={toolMode === "draw"} label="手绘标注" shortcut="B" onClick={() => setToolMode("draw")}><Pencil size={18} /></ToolButton>
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
            <div className="device-tabs" aria-label="预览尺寸">
              <button className={device === "desktop" ? "active" : ""} onClick={() => setDevice("desktop")} aria-label="桌面预览" type="button"><Monitor size={16} /></button>
              <button className={device === "tablet" ? "active" : ""} onClick={() => setDevice("tablet")} aria-label="平板预览" type="button"><Tablet size={16} /></button>
              <button className={device === "mobile" ? "active" : ""} onClick={() => setDevice("mobile")} aria-label="手机预览" type="button"><Smartphone size={16} /></button>
            </div>
            <span className="canvas-size">{deviceSize.width} × {deviceSize.height}</span>
            <div className="canvas-hint">
              {toolMode === "select" && <><MousePointer2 size={13} />点击页面元素以编辑</>}
              {toolMode === "region" && <><BoxSelect size={13} />拖动圈出需要修改的区域</>}
              {toolMode === "draw" && <><Pencil size={13} />在页面上手绘标记</>}
            </div>
          </div>

          <div
            className="canvas-scroller"
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleDrop}
          >
            <div
              className={`device-frame tool-${toolMode}`}
              style={{ width: deviceSize.width, height: deviceSize.height }}
            >
              <iframe
                ref={iframeRef}
                srcDoc={previewHtml}
                title="HTML 页面预览"
                sandbox="allow-same-origin"
                referrerPolicy="no-referrer"
                onLoad={() => wireIframe()}
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

              {hoverRect && toolMode === "select" && !selection && (
                <div className="hover-outline" style={{ left: hoverRect.x, top: hoverRect.y, width: hoverRect.width, height: hoverRect.height }} />
              )}
              {selection?.type === "element" && (
                <div className="selection-outline" style={{ left: selection.rect.x, top: selection.rect.y, width: selection.rect.width, height: selection.rect.height }}>
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

          <div className="canvas-statusbar">
            <span><span className="status-dot" />预览已隔离，页面脚本不会执行</span>
            <span>{historyIndex + 1} / {history.length} 个版本</span>
          </div>
        </section>

        <aside className={`ai-panel ${panelOpen ? "open" : ""}`}>
          <div className="panel-header">
            <div className="panel-tabs">
              <button className={panelTab === "chat" ? "active" : ""} onClick={() => setPanelTab("chat")} type="button"><MessageSquare size={15} />AI 编辑</button>
              <button className={panelTab === "code" ? "active" : ""} onClick={() => setPanelTab("code")} type="button"><Code2 size={15} />HTML</button>
            </div>
            <button className="panel-close" onClick={() => setPanelOpen(false)} aria-label="关闭面板" type="button"><X size={17} /></button>
          </div>

          {panelTab === "chat" ? (
            <>
              <div className="chat-scroll">
                <div className="context-banner">
                  <div className="ai-orb"><Sparkles size={15} /></div>
                  <div><strong>从想法到页面</strong><span>聊天、圈选、手绘和参考图都在同一条编辑流里。</span></div>
                </div>

                <div className="message-list">
                  {messages.map((message) => (
                    <article key={message.id} className={`message ${message.role} ${message.error ? "error" : ""}`}>
                      {message.role === "assistant" && <span className="message-avatar"><Wand2 size={14} /></span>}
                      <div className="message-bubble">
                        <p>{message.text}</p>
                        {message.detail && <span>{message.detail}</span>}
                        {message.role === "assistant" && message.id !== "welcome" && !message.error && (
                          <button onClick={undo} disabled={!canUndo} type="button"><Undo2 size={12} />撤销这次修改</button>
                        )}
                      </div>
                    </article>
                  ))}
                  {isWorking && (
                    <article className="message assistant working">
                      <span className="message-avatar"><Wand2 size={14} /></span>
                      <div className="message-bubble"><p><Loader2 className="spin" size={14} />正在理解页面并生成修改…</p></div>
                    </article>
                  )}
                  <div ref={chatEndRef} />
                </div>

                {messages.length < 3 && (
                  <div className="suggestions">
                    <span>试试这样说</span>
                    <div>
                      {PROMPT_SUGGESTIONS.map((suggestion) => (
                        <button key={suggestion} onClick={() => { setPrompt(suggestion); promptRef.current?.focus(); }} type="button">{suggestion}</button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="composer-wrap">
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
                    onChange={(event) => setPrompt(event.target.value)}
                    onKeyDown={handlePromptKeydown}
                    placeholder={selection ? "描述你希望如何修改这里…" : "描述你想要的页面修改…"}
                    rows={3}
                    disabled={isWorking}
                  />
                  <div className="composer-actions">
                    <div>
                      <button onClick={() => fileInputRef.current?.click()} aria-label="添加文档" title="添加文本、Markdown、HTML 或 CSS" type="button"><Paperclip size={17} /></button>
                      <button onClick={() => imageInputRef.current?.click()} aria-label="添加参考图" title="添加参考图" type="button"><ImageIcon size={17} /></button>
                    </div>
                    <button className="send-button" onClick={() => void sendPrompt()} disabled={isWorking || (!prompt.trim() && !attachments.length)} aria-label="发送" type="button">
                      {isWorking ? <Loader2 className="spin" size={17} /> : <Send size={17} />}
                    </button>
                  </div>
                </div>
                <div className="composer-meta">
                  <button onClick={openSettings} type="button">
                    <span className="provider-mini" style={{ background: provider.color }} />
                    {provider.name}<ChevronDown size={12} />
                  </button>
                  <span>Enter 发送 · Shift Enter 换行</span>
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
                onChange={(event) => setCodeDraft(event.target.value)}
                spellCheck={false}
                aria-label="HTML 源码"
              />
              <div className="code-footer">
                <button className="ghost-code" onClick={() => setCodeDraft(currentHtml)} type="button"><Trash2 size={14} />放弃修改</button>
                <button className="apply-code" onClick={() => { commitHtml(codeDraft); showToast("代码已应用"); }} disabled={codeDraft === currentHtml} type="button"><Check size={14} />应用到画布</button>
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
                  {(draftConfig.providerId === "local" || draftConfig.providerId === "copilot") && (
                    <div className="local-note">
                      <Monitor size={15} />
                      Docker 用户请使用 <code>host.docker.internal</code> 指向宿主机；非 Docker 运行可改为 <code>127.0.0.1</code>。
                    </div>
                  )}
                </div>
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
