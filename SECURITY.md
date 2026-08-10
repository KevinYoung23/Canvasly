# Security / 安全说明

## Reporting a vulnerability

Please do not open a public issue for an unpatched vulnerability or leaked credential. Use GitHub's private vulnerability reporting for this repository when available, or contact the repository owner privately.

Include the affected version, reproduction steps, impact, and any suggested mitigation. Please avoid accessing data that does not belong to you.

## 报告安全问题

请不要为尚未修复的漏洞或泄露凭据创建公开 Issue。优先使用本仓库的 GitHub 私密漏洞报告功能，或私下联系仓库维护者。

报告中请包含受影响版本、复现步骤、影响范围和可行的修复建议。请勿访问不属于你的数据。

## Security boundaries

- Model credentials are held in browser memory only.
- The bundled Compose stack binds to `127.0.0.1` and disables private endpoint access by default.
- Literal localhost and private IP endpoints require explicit operator opt-in through `ALLOW_PRIVATE_LLM_ENDPOINTS=true`.
- Remote model endpoint hostnames must use HTTPS. Operators remain responsible for outbound network policy, including DNS-resolved private addresses.
- Redirects and oversized inputs are rejected.
- Generated scripts are removed before preview rendering.
- The preview iframe is sandboxed and protected by CSP.
- Stale model responses cannot replace newer local edits.

## 安全边界

- 模型凭据只保存在浏览器内存中。
- 随附的 Compose 配置默认仅绑定 `127.0.0.1`，并关闭私有节点访问。
- localhost 与私有 IP 节点只有在运维者明确设置 `ALLOW_PRIVATE_LLM_ENDPOINTS=true` 后才能访问。
- 远程模型节点域名必须使用 HTTPS；运维者仍需负责出站网络策略，包括解析到私有地址的 DNS 域名。
- 系统会拒绝重定向和超出大小限制的输入。
- 生成内容中的脚本会在预览渲染前移除。
- 预览 iframe 受到 sandbox 与 CSP 保护。
- 过期模型响应不能覆盖较新的本地编辑。
