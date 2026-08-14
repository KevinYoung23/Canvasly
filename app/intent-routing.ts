export type FallbackUnifiedAction = "chat" | "plan" | "agent";

const EDIT_INTENT =
  /\b(?:add(?:ing)?|apply(?:ing)?|build(?:ing)?|chang(?:e|ing)|convert(?:ing)?|creat(?:e|ing)|delet(?:e|ing)|edit(?:ing)?|fix(?:ing)?|generat(?:e|ing)|implement(?:ing)?|improv(?:e|ing)|insert(?:ing)?|mak(?:e|ing)|modif(?:y|ying)|mov(?:e|ing)|optimiz(?:e|ing)|redesign(?:ing)?|refactor(?:ing)?|remov(?:e|ing)|replac(?:e|ing)|rewrit(?:e|ing)|updat(?:e|ing))\b|(?:修改|更改|更新|添加|新增|插入|删除|移除|替换|重写|重做|重构|优化|改进|调整|移动|创建|生成|实现|修复|应用|转换|改成|改为|设计)/i;

const AFFIRMATIVE_EDIT_COMMAND =
  /^(?:\s*(?:please|kindly)\s+)?(?:add|apply|build|change|convert|create|delete|edit|fix|generate|implement|improve|insert|make|modify|move|optimize|redesign|refactor|remove|replace|rewrite|update)\b|^\s*(?:(?:请|请你|请帮我|帮我)\s*)?(?:(?:修改|更改|更新|添加|新增|插入|删除|移除|替换|重写|重做|重构|优化|改进|调整|移动|创建|生成|实现|修复|应用|转换|设计)|(?:把|将).{0,80}(?:改成|改为|修改|更改|更新|添加|删除|替换|移动)|让(?!我|我们).{1,80}(?:更|变得|呈现|显示))/i;

const PAGE_TARGET =
  /\b(?:html|page|canvas|section|component|hero|heading|headline|button|navigation|navbar|layout|style|color|content|copy|image|form|card|table|footer|header|sidebar|modal|grid)\b|(?:页面|画布|区域|组件|首屏|标题|按钮|导航|布局|样式|颜色|内容|文案|图片|表单|卡片|表格|页脚|页头|侧栏|弹窗|网格)/i;

export function fallbackUnifiedAction(
  instruction: string,
  hasSelection = false,
): FallbackUnifiedAction {
  if (
    /(?:先|只|帮我)?(?:规划|计划|方案|梳理思路|分析方案)|\b(?:plan|planning|proposal|roadmap)\b/i.test(
      instruction,
    )
  ) {
    return "plan";
  }
  if (
    /[?？]|\b(?:why|what|how|which|brainstorm|research|search|explain|review|feedback|opinion|ideas?|suggestions?|summari[sz]e|summary|unchanged|read-only)\b|(?:为什么|是什么|怎么|如何|哪些|讨论|聊聊|查找|搜索|调研|建议|反馈|评价|想法|思路|总结|概括|只读|保持不变|不要动)/i.test(
      instruction,
    )
  ) {
    return "chat";
  }
  const negatedEdit =
    EDIT_INTENT.test(instruction) &&
    (/\b(?:no|not|never|without|avoid|refrain|don't|dont)\b/i.test(
      instruction,
    ) ||
      /(?:请勿|勿|不要|别|无需|不需要|禁止|避免|不(?:作|做|进行)?(?:任何)?\s*(?:修改|更改|更新|添加|新增|插入|删除|移除|替换|重写|重做|重构|优化|改进|调整|移动|创建|生成|实现|修复|应用|转换|改成|改为|设计))/i.test(
        instruction,
      ));
  if (
    !negatedEdit &&
    AFFIRMATIVE_EDIT_COMMAND.test(instruction) &&
    (hasSelection || PAGE_TARGET.test(instruction))
  ) {
    return "agent";
  }
  return "chat";
}
