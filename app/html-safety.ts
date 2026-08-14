const NON_RENDERING_BLOCKS =
  /<(?:script|style|template|noscript)\b[^>]*>[\s\S]*?<\/(?:script|style|template|noscript)\s*>/gi;
const RENDERABLE_ELEMENTS =
  /<(?:img|picture|svg|canvas|video|audio|iframe|object|embed|input|textarea|select|button|table|hr|meter|progress)\b/i;
const POTENTIALLY_STYLED_ELEMENTS =
  /<(?:div|main|section|article|aside|header|footer|nav|span|a)\b[^>]*(?:class|id|style)\s*=/i;
const NEGATED_BLANK_PAGE_REQUEST =
  /(?:不要|不可|不能|别|无需|避免)[^。！？]{0,24}(?:(?:清空|置空|删除|移除)|(?:返回|创建|改成|变成)[^。！？]{0,8}(?:空白|空的)(?:页面|画布))|\b(?:do\s+not|don't|never|without|avoid)\b[^.?!]{0,24}(?:(?:clear|empty|remove|delete)\b|(?:return|create|make|turn)?[^.?!]{0,8}(?:blank|empty)\s+(?:page|canvas)\b)/i;
const EXPLICIT_BLANK_PAGE_REQUEST =
  /^\s*(?:(?:请\s*)?(?:(?:清空|置空)(?:整个|整张)?(?:页面|画布)(?:的?全部内容)?|(?:删除|移除)(?:整个|整张)(?:页面|画布)(?:的?全部内容)?|(?:删除|移除)(?:页面|画布)的?全部内容|(?:把|将)(?:整个|整张)?(?:页面|画布)(?:的?全部内容)?(?:清空|置空|删除|移除)|(?:把|将)(?:整个|整张)?(?:页面|画布)(?:改成|变成)(?:一个)?(?:空白|空的)(?:页面|画布)?|(?:创建|新建)(?:一个)?(?:空白|空的)(?:页面|画布))(?:\s*[，,]\s*(?:并)?(?:返回|保留)(?:一个)?(?:空白|空的)(?:页面|画布))?|(?:please\s+)?(?:(?:clear|empty)\s+(?:the\s+)?(?:entire\s+)?(?:page|canvas)(?:\s+(?:of\s+all\s+)?content)?|(?:remove|delete)\s+all\s+(?:content|everything)\s+from\s+(?:the\s+)?(?:page|canvas)|(?:make|turn)\s+(?:the\s+)?(?:entire\s+)?(?:page|canvas)\s+(?:blank|empty)|create\s+(?:a\s+)?(?:blank|empty)\s+(?:page|canvas))(?:\s+(?:and|then)\s+(?:return|keep)\s+(?:a\s+)?(?:blank|empty)\s+(?:page|canvas))?)\s*[。.!！]?\s*$/i;

function bodyMarkup(source: string) {
  const body = source.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i);
  if (body) return body[1];
  return source.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, "");
}

export function hasRenderableBodyContent(source: string) {
  if (!source.trim()) return false;
  const markup = bodyMarkup(source)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(NON_RENDERING_BLOCKS, "");
  if (
    RENDERABLE_ELEMENTS.test(markup) ||
    POTENTIALLY_STYLED_ELEMENTS.test(markup)
  ) {
    return true;
  }

  const visibleText = markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:nbsp|#160|#xA0);/gi, " ")
    .replace(/&(?:#\d+|#x[\da-f]+|[a-z][\w]+);/gi, "x")
    .replace(/\s+/g, "");
  if (visibleText.length > 0) return true;

  return /content\s*:\s*["'][^"']+["']/i.test(source);
}

export function instructionAllowsBlankPage(instruction: string) {
  return (
    !NEGATED_BLANK_PAGE_REQUEST.test(instruction) &&
    EXPLICIT_BLANK_PAGE_REQUEST.test(instruction)
  );
}

export function wouldReplacePageWithBlank(
  currentHtml: string,
  nextHtml: string,
  instruction: string,
) {
  return (
    hasRenderableBodyContent(currentHtml) &&
    !hasRenderableBodyContent(nextHtml) &&
    !instructionAllowsBlankPage(instruction)
  );
}

export function findRecoverableHistoryIndex(
  history: string[],
  currentIndex: number,
  intentionalBlankFlags: boolean[] = [],
) {
  if (
    hasRenderableBodyContent(history[currentIndex] ?? "") ||
    intentionalBlankFlags[currentIndex] === true
  ) {
    return currentIndex;
  }
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    if (
      hasRenderableBodyContent(history[index]) ||
      intentionalBlankFlags[index] === true
    ) {
      return index;
    }
  }
  return currentIndex;
}
