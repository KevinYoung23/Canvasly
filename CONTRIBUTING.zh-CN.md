<p align="right"><a href="./CONTRIBUTING.md">English</a> · <strong>简体中文</strong></p>

# 参与 Canvasly 开发

感谢你帮助我们把人机协作界面做得更直接、更可检查，也更实用。

## 开始之前

- 先搜索已有 Issue 与 Pull Request。
- 每次修改尽量聚焦于一个行为或产品结果。
- 交互或视觉变更请附上前后截图或短视频。
- 不要提交 API key、token、生成的凭据或本地 `.env` 文件。

## 本地环境

```bash
npm ci
npm run dev
```

打开 `http://127.0.0.1:5173`。

## 质量要求

运行与本次修改相关的检查：

```bash
npm run lint
node --check tools/copilot-bridge.mjs
```

Linux 或具有 GNU `timeout` 的环境：

```bash
npm test
```

macOS 等价验证：

```bash
bash scripts/sites-env.sh -- ./node_modules/.bin/vinext build
bash scripts/validate-artifact.sh
node --test tests/rendered-html.test.mjs
```

界面变更需要验证桌面、平板和手机宽度。涉及相关区域时，请确认选择框、自由移动、手绘、画布局部缩放、Cowork、Chat、Steer 与 Queue 仍能一致工作。

## Pull Request

一份清晰的 PR 应说明：

1. 用户问题。
2. 行为变化。
3. 风险或取舍。
4. 验证方式。
5. 可见变更对应的截图或媒体。
