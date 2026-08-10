# Canvasly — AI Assisted HTML Editor

Canvasly 是一个面向大众用户的可视化 HTML 编辑器。你可以像使用普通 AI 助手一样聊天，也可以直接点击页面元素、圈选区域、手绘标注，再用文字、参考图或文档描述需要的修改。

它默认带有无需密钥的演示模式；连接自己的模型节点后，会调用真实模型生成完整 HTML，并立即在安全预览中显示结果。

## 主要能力

- 对话式编辑：用自然语言连续修改页面
- 双协作模式：Chat 只讨论页面与方案，不修改画布；Cowork 面向选择、生成和 HTML 编辑
- Agent 跟进：任务运行中仍可输入，使用 Steer 优先跟进或 Queue 顺序排队
- 指令历史：在输入框第一行使用 `↑` / `↓` 浏览当前模式的历史指令与未发送草稿
- 项目入口：从空白 HTML 新建页面，或加载本机现有的 `.html` / `.htm` 文件继续编辑
- 元素选择：点击标题、按钮、卡片等 DOM 元素后定向修改
- 页面操作：切换到操作模式后可直接点击按钮、聚焦表单并输入文字，不触发元素选择
- 自由编排：像 PPT 一样连续移动多个组件，实时预览后统一确认并渲染到 HTML
- 批量撤销：确认前可撤销单步或放弃全部，确认后也可一键撤销整批移动
- 圈选与手绘：拖出区域或直接画出关注范围
- 多模态参考：上传 PNG、JPEG、WebP、GIF，以及文本、Markdown、HTML、CSS、JSON 等文档
- 实时预览：桌面、平板、手机三个尺寸
- 自适应画布：左右工具栏或 AI 面板展开时自动缩放，始终完整显示页面
- 局部缩放：光标位于画布时使用触控板捏合或 `Ctrl` / `⌘` + 滚轮，仅缩放画布并保持光标锚点
- 智能工作台：当前工具、视口、DOM 上下文和 Agent 状态集中显示
- 可恢复编辑：最多保留 30 个会话内版本，支持撤销与重做
- 源码模式：直接查看、复制和修改完整 HTML
- 一键导出：下载独立的 `.html` 文件
- 自带模型适配：OpenAI、Claude、Qwen、DeepSeek、GitHub Copilot、本地模型和自定义节点

## 一键安装

需要先安装 [Docker Desktop](https://www.docker.com/products/docker-desktop/)。

macOS / Linux：

```bash
./install.sh
```

Windows PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会自动构建并启动应用，然后打开 [http://localhost:4173](http://localhost:4173)。首次构建需要下载依赖，之后可直接运行：

```bash
docker compose up -d
```

停止服务：

```bash
docker compose down
```

## 连接模型

在编辑器右上角点击当前模型名称，选择服务并填写节点地址、模型名称和 API 密钥。密钥只存在于当前浏览器内存，并随每次编辑请求发送到你自己的 Canvasly 服务；不会写入浏览器存储或仓库文件。

| 服务 | 协议 | 默认节点 | 说明 |
|---|---|---|---|
| OpenAI | Responses API | `https://api.openai.com/v1` | 支持文本和参考图 |
| Claude | Anthropic Messages | `https://api.anthropic.com` | 原生 Claude 接口 |
| Qwen | OpenAI Chat Completions | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 可替换为工作空间专属节点 |
| DeepSeek | OpenAI Chat Completions | `https://api.deepseek.com` | 兼容 DeepSeek 官方接口 |
| GitHub Copilot | Responses API / 本机登录 | `http://host.docker.internal:4141/v1` | 可直接使用本机已登录的服务，通常无需 API 密钥 |
| 本地模型 | OpenAI Chat Completions | `http://host.docker.internal:11434/v1` | 适用于 Ollama、LM Studio、vLLM 等 |
| 自定义 | Responses API / Chat Completions | `http://127.0.0.1:4141/v1` | 默认模型 `gpt-5.5`，也可改为其他兼容服务并切换协议 |

对于不需要 API 密钥的本地节点，密钥栏可以留空。

### GitHub Copilot

如果本机 `4141` 已提供 OpenAI Responses-compatible 服务，在 Canvasly 中直接选择 “GitHub Copilot” 即可，API 密钥留空。本地 `npm run dev` 会自动允许该 localhost 节点。

Canvasly 也提供一个基于官方 `@github/copilot-sdk` 的可选 bridge。安装 GitHub Copilot CLI 后先登录：

```bash
copilot login
```

bridge 会优先复用该登录用户，无需 token。然后运行：

```bash
./install.sh --copilot
```

Windows：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 --copilot
```

之后在 Canvasly 中选择 “GitHub Copilot”。只有主动设置了 `COPILOT_BRIDGE_API_KEY` 时，才需要把相同值填入界面的 API 密钥栏。

也可以不启动内置 bridge，直接填写你已有的 OpenAI-compatible Copilot 网关节点。

### 本地模型与局域网节点

Docker 运行时，节点地址里的宿主机应写成 `host.docker.internal`，例如：

```text
http://host.docker.internal:11434/v1
```

直接通过 Node.js 运行 Canvasly 时，可以使用 `127.0.0.1`。本地及局域网节点只在 `ALLOW_PRIVATE_LLM_ENDPOINTS=true` 时允许访问；公开部署时建议保持关闭。

## 本地开发

要求 Node.js 22.13 或更高版本。

```bash
npm ci
npm run dev
```

常用检查：

```bash
npm run lint
npm test
node --check tools/copilot-bridge.mjs
```

## 工作方式

1. 新建空白页面或打开现有 HTML；浏览器在当前会话中保存 HTML、历史版本、圈选信息和附件。
2. Canvasly 后端将用户描述、完整 HTML、选中元素与附件统一转换为供应商请求。
3. 不同适配器分别调用 OpenAI Responses、Anthropic Messages 或 OpenAI-compatible Chat Completions。
4. 模型只返回完整 HTML 与简短修改摘要。
5. 新页面在禁用脚本的隔离 iframe 中预览；导出时保留模型生成的完整 HTML。

## 安全边界

- API 密钥不写入 localStorage、日志或项目文件。
- 远程节点必须使用 HTTPS；HTTP 仅允许自托管环境中的本地或局域网地址。
- 后端拒绝远程重定向，并限制 HTML、附件和请求大小。
- 预览会删除脚本并使用 CSP 与 iframe sandbox，避免生成页面执行 JavaScript。
- `ALLOW_PRIVATE_LLM_ENDPOINTS=true` 适合本地使用，不建议用于暴露在公网的共享实例。

## 项目结构

```text
app/
  api/transform/route.ts   # 多供应商模型适配与安全校验
  editor-data.ts           # 模型预设、示例 HTML、快捷提示
  page.tsx                 # 编辑器交互与状态
  globals.css              # 完整响应式界面
tools/
  copilot-bridge.mjs       # 官方 GitHub Copilot SDK bridge
compose.yaml               # 一键自托管
Dockerfile                 # 生产镜像
install.sh                 # macOS / Linux 安装入口
install.ps1                # Windows 安装入口
```

## 当前范围

这是首个完整可用版本。项目状态保存在当前会话中，刷新后会回到示例页面；多人协作、云端项目存储、组件库和可视化属性面板可在后续版本加入。
