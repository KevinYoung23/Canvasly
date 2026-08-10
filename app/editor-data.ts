export type ProviderProtocol =
  | "demo"
  | "openai-responses"
  | "openai-chat"
  | "anthropic";

export type ProviderId =
  | "demo"
  | "openai"
  | "anthropic"
  | "qwen"
  | "deepseek"
  | "copilot"
  | "local"
  | "custom";

export type ProviderPreset = {
  id: ProviderId;
  name: string;
  label: string;
  description: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  model: string;
  keyPlaceholder: string;
  color: string;
};

export const PROVIDERS: ProviderPreset[] = [
  {
    id: "demo",
    name: "Canvasly Demo",
    label: "无需密钥",
    description: "先体验圈选与编辑流程；不会调用外部模型。",
    protocol: "demo",
    baseUrl: "",
    model: "canvasly-demo",
    keyPlaceholder: "",
    color: "#6f55e8",
  },
  {
    id: "openai",
    name: "OpenAI",
    label: "Responses API",
    description: "适合 GPT 系列模型，支持图像作为编辑参考。",
    protocol: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.6",
    keyPlaceholder: "sk-...",
    color: "#111111",
  },
  {
    id: "anthropic",
    name: "Claude",
    label: "Anthropic API",
    description: "通过原生 Messages API 连接 Claude。",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-5",
    keyPlaceholder: "sk-ant-...",
    color: "#c96f46",
  },
  {
    id: "qwen",
    name: "Qwen",
    label: "Model Studio",
    description: "连接阿里云百炼或任意 Qwen OpenAI-compatible 节点。",
    protocol: "openai-chat",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3-coder-plus",
    keyPlaceholder: "sk-...",
    color: "#6d5dfc",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    label: "OpenAI compatible",
    description: "使用 DeepSeek 官方接口或兼容节点。",
    protocol: "openai-chat",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    keyPlaceholder: "sk-...",
    color: "#3676ef",
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    label: "本机登录 / Responses",
    description: "连接本机已登录的 Copilot 服务；无需在 Canvasly 中填写 API 密钥。",
    protocol: "openai-responses",
    baseUrl: "http://host.docker.internal:4141/v1",
    model: "auto",
    keyPlaceholder: "通常留空",
    color: "#24292f",
  },
  {
    id: "local",
    name: "Local model",
    label: "Ollama · LM Studio · vLLM",
    description: "连接本机或局域网中的 OpenAI-compatible 服务。",
    protocol: "openai-chat",
    baseUrl: "http://host.docker.internal:11434/v1",
    model: "qwen3-coder:30b",
    keyPlaceholder: "通常无需密钥",
    color: "#16856b",
  },
  {
    id: "custom",
    name: "Custom endpoint",
    label: "Responses / Chat",
    description: "连接任意 OpenAI-compatible 节点，并选择它实际支持的请求协议。",
    protocol: "openai-responses",
    baseUrl: "http://127.0.0.1:4141/v1",
    model: "gpt-5.5",
    keyPlaceholder: "API key（可选）",
    color: "#7b7f8c",
  },
];

export const BLANK_HTML = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Untitled page</title>
    <style>
      html, body { min-height: 100%; }
      body { margin: 0; background: #ffffff; }
    </style>
  </head>
  <body></body>
</html>`;

export const STARTER_HTML = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Northstar — Plan less. Go further.</title>
    <style>
      * { box-sizing: border-box; }
      :root {
        --ink: #1d1b20;
        --muted: #77727f;
        --accent: #7458e9;
        --paper: #fbfaf7;
        --line: #e8e4dd;
      }
      body {
        margin: 0;
        color: var(--ink);
        background: var(--paper);
        font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .page { min-height: 100vh; overflow: hidden; }
      .nav {
        height: 74px;
        max-width: 1120px;
        margin: 0 auto;
        padding: 0 28px;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .brand { display: flex; align-items: center; gap: 10px; font-weight: 750; letter-spacing: -0.03em; }
      .brand-mark {
        width: 25px; height: 25px; border-radius: 8px;
        background: var(--ink); position: relative; transform: rotate(-7deg);
      }
      .brand-mark::after {
        content: ""; position: absolute; width: 8px; height: 8px; border-radius: 50%;
        background: #d7ff69; top: 5px; right: 5px;
      }
      .nav-links { display: flex; align-items: center; gap: 28px; font-size: 13px; color: #625e67; }
      .nav-links a { color: inherit; text-decoration: none; }
      .nav-cta {
        border: 1px solid #d9d4cb; border-radius: 999px; padding: 10px 15px;
        background: rgba(255,255,255,.65); color: var(--ink); font-weight: 650;
      }
      .hero {
        max-width: 1120px;
        margin: 28px auto 0;
        padding: 38px 28px 66px;
        display: grid;
        grid-template-columns: 1.04fr .96fr;
        align-items: center;
        gap: 54px;
      }
      .eyebrow {
        width: fit-content; display: flex; align-items: center; gap: 8px;
        padding: 8px 12px; border: 1px solid var(--line); border-radius: 999px;
        background: rgba(255,255,255,.62); color: #5d5962; font-size: 12px; font-weight: 650;
      }
      .eyebrow-dot { width: 7px; height: 7px; border-radius: 50%; background: #6fcf8d; box-shadow: 0 0 0 4px #e8f7ed; }
      h1 {
        margin: 22px 0 18px; max-width: 620px; font-family: Georgia, "Times New Roman", serif;
        font-size: clamp(48px, 6.1vw, 78px); font-weight: 500; line-height: .96; letter-spacing: -.055em;
      }
      h1 em { color: var(--accent); font-weight: 500; }
      .lead { max-width: 480px; color: var(--muted); font-size: 17px; line-height: 1.7; }
      .actions { display: flex; align-items: center; gap: 14px; margin-top: 28px; }
      .primary-btn {
        border: 0; border-radius: 999px; padding: 14px 20px; background: var(--ink); color: white;
        font-weight: 700; box-shadow: 0 10px 28px rgba(29,27,32,.16);
      }
      .secondary-btn { color: #5c5761; font-size: 13px; font-weight: 650; }
      .visual { position: relative; min-height: 465px; }
      .orb { position: absolute; border-radius: 50%; filter: blur(.2px); }
      .orb-a { width: 270px; height: 270px; background: #ded3ff; top: 14px; right: 18px; }
      .orb-b { width: 210px; height: 210px; background: #d7ff69; bottom: 14px; left: 20px; }
      .route-card {
        position: absolute; inset: 58px 34px 44px 50px; padding: 23px; border-radius: 28px;
        background: rgba(255,255,255,.86); border: 1px solid rgba(255,255,255,.9);
        box-shadow: 0 30px 70px rgba(57,42,97,.18); backdrop-filter: blur(16px); transform: rotate(2.6deg);
      }
      .route-top { display: flex; justify-content: space-between; align-items: center; }
      .route-label { color: #8b8492; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
      .avatar-stack { display: flex; }
      .avatar { width: 27px; height: 27px; border: 2px solid white; border-radius: 50%; margin-left: -7px; background: #f0b98a; }
      .avatar:nth-child(2) { background: #8fd7cf; }
      .avatar:nth-child(3) { background: #b9a4ed; }
      .route-card h2 { margin: 15px 0 5px; font-size: 25px; letter-spacing: -.04em; }
      .route-meta { color: #88818c; font-size: 12px; }
      .map {
        position: relative; height: 190px; margin-top: 20px; border-radius: 20px; overflow: hidden;
        background: linear-gradient(145deg, #eee9f8, #e9f0df);
      }
      .map::before, .map::after {
        content: ""; position: absolute; border: 2px dashed rgba(116,88,233,.55); border-radius: 50%;
      }
      .map::before { width: 195px; height: 100px; left: 42px; top: 41px; transform: rotate(-10deg); }
      .map::after { width: 100px; height: 190px; right: 26px; top: -26px; transform: rotate(22deg); }
      .pin { position: absolute; width: 16px; height: 16px; border: 4px solid white; border-radius: 50%; background: var(--accent); box-shadow: 0 5px 12px rgba(69,50,137,.3); }
      .pin-a { left: 70px; top: 95px; } .pin-b { right: 74px; top: 50px; background: #ff8d72; }
      .trip-footer { display: flex; justify-content: space-between; align-items: center; margin-top: 17px; }
      .stat strong { display: block; font-size: 15px; } .stat span { color: #918b95; font-size: 10px; }
      .weather { display: flex; gap: 7px; align-items: center; padding: 9px 12px; border-radius: 13px; background: #f4f1eb; font-size: 12px; font-weight: 650; }
      .proof {
        max-width: 1064px; margin: 0 auto 58px; padding: 0 28px; display: grid;
        grid-template-columns: repeat(3, 1fr); gap: 14px;
      }
      .proof-card { padding: 18px 20px; border-top: 1px solid var(--line); display: flex; gap: 12px; align-items: flex-start; }
      .proof-num { color: var(--accent); font-family: Georgia, serif; font-size: 23px; }
      .proof-card p { margin: 2px 0 0; color: #817b84; font-size: 11px; line-height: 1.55; }
      .proof-card strong { display: block; color: #37333a; font-size: 12px; margin-bottom: 2px; }
      @media (max-width: 760px) {
        .nav-links a { display: none; }
        .hero { grid-template-columns: 1fr; padding-top: 16px; }
        .visual { min-height: 400px; }
        .proof { grid-template-columns: 1fr; }
        h1 { font-size: 54px; }
      }
    </style>
  </head>
  <body>
    <div class="page">
      <nav class="nav">
        <div class="brand"><span class="brand-mark"></span>Northstar</div>
        <div class="nav-links">
          <a href="#">Destinations</a><a href="#">Stories</a><a href="#">About</a>
          <button class="nav-cta">Build a trip</button>
        </div>
      </nav>
      <main class="hero">
        <section class="hero-copy">
          <div class="eyebrow"><span class="eyebrow-dot"></span> Thoughtful travel, made simple</div>
          <h1>Plan less.<br />Go <em>further.</em></h1>
          <p class="lead">Tell us what moves you. Northstar turns scattered ideas into a personal route—beautifully paced, easy to share, and ready when you are.</p>
          <div class="actions">
            <button class="primary-btn">Start planning →</button>
            <span class="secondary-btn">See a sample trip</span>
          </div>
        </section>
        <section class="visual">
          <div class="orb orb-a"></div><div class="orb orb-b"></div>
          <article class="route-card">
            <div class="route-top"><span class="route-label">Your next escape</span><div class="avatar-stack"><span class="avatar"></span><span class="avatar"></span><span class="avatar"></span></div></div>
            <h2>Seven days in Portugal</h2><div class="route-meta">Lisbon · Comporta · Porto</div>
            <div class="map"><span class="pin pin-a"></span><span class="pin pin-b"></span></div>
            <div class="trip-footer"><div class="stat"><strong>1,284 km</strong><span>CURATED ROUTE</span></div><div class="weather">☀ 24° · May</div></div>
          </article>
        </section>
      </main>
      <section class="proof">
        <article class="proof-card"><span class="proof-num">01</span><div><strong>Built around you</strong><p>Not a list of places—a route shaped around your pace.</p></div></article>
        <article class="proof-card"><span class="proof-num">02</span><div><strong>Ready in minutes</strong><p>From first idea to a shareable, bookable itinerary.</p></div></article>
        <article class="proof-card"><span class="proof-num">03</span><div><strong>Easy to reshape</strong><p>Swap a stop, slow it down, or invite a friend anytime.</p></div></article>
      </section>
    </div>
  </body>
</html>`;

export const PROMPT_SUGGESTIONS = [
  "让主标题更有杂志感",
  "把右侧卡片改成深色玻璃质感",
  "增加按钮的视觉层级",
  "让整体配色更适合夏日旅行",
];
