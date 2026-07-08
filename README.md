# Local OpenAI Page Translator

一个接近 Edge 自带网页翻译体验的本地版扩展：

- API key 只放在本机 `proxy/.env`，不会写进浏览器扩展源码。
- Edge 扩展读取网页可见文本，通过本地代理调用 OpenAI。
- 点击扩展按钮或右键菜单开始翻译。
- 阅读时继续向下滚动，新出现的文本会自动翻译。
- 支持“替换原文”和“双语显示”两种模式。

## 目录

```text
extension/        Edge 扩展源码，加载这个目录
proxy/            本地 OpenAI 翻译代理
start-proxy.ps1   启动代理的 PowerShell 脚本
```

## 1. 填写 API key

复制配置文件：

```powershell
Copy-Item .\proxy\.env.example .\proxy\.env
```

打开 `proxy/.env`，把这一行换成你的 key：

```text
OPENAI_API_KEY=sk-your-api-key-here
```

默认模型是：

```text
OPENAI_MODEL=gpt-5.5
OPENAI_API_MODE=responses
OPENAI_REASONING_EFFORT=low
OPENAI_TEXT_VERBOSITY=low
```

如果优先考虑成本可直接用 `gpt-5.5`。翻译任务通常不需要很高推理强度，先用 `OPENAI_REASONING_EFFORT=low` 能兼顾术语质量和响应速度；如果遇到特别绕的理论段落，可以改成 `medium`。如果你已经运行过启动脚本并生成了 `proxy/.env`，请改 `proxy/.env` 里的这些配置，因为 `.env.example` 不会自动覆盖已有配置。

如果使用 OpenAI-compatible 中转，例如 `https://colabapi.com/v1`，并且它不支持 `/v1/responses`，可以改成：

```text
OPENAI_BASE_URL=https://colabapi.com/v1
OPENAI_API_MODE=chat
```

## 2. 启动本地代理

在项目根目录运行：

```powershell
.\start-proxy.ps1
```

看到类似输出就表示代理已启动：

```text
OpenAI page translate proxy listening on http://127.0.0.1:8787
```

这个窗口要保持打开。关闭后扩展就无法翻译。

## 3. 在 Edge 加载扩展

1. 打开 Edge，进入 `edge://extensions/`。
2. 打开左侧或页面上的“开发人员模式”。
3. 点击“加载解压缩的扩展”。
4. 选择本项目里的 `extension` 文件夹。

## 4. 使用

- 打开一个外语网页。
- 点击浏览器工具栏里的扩展图标，开始翻译。
- 也可以在页面空白处右键，选择“用 OpenAI 翻译此页”。
- 页面右上角会出现一个小翻译条：
  - `翻译`：继续扫描并翻译当前可见内容。
  - `暂停`：停止滚动自动翻译。
  - `原文`：恢复已经替换过的原文。
  - `替换 / 双语`：切换显示模式。

## 常见问题

### 点击后提示代理失败

确认 `.\start-proxy.ps1` 正在运行，并且 `proxy/.env` 里填了 `OPENAI_API_KEY`。

如果错误是 `fetch failed`，通常是 Node.js 直连 `api.openai.com` 失败。浏览器能联网不代表 Node.js 会自动走同一个代理。可以在 `proxy/.env` 里加入你的本地 HTTP 代理，例如：

```text
OPENAI_HTTP_PROXY=http://127.0.0.1:7890
```

常见本地代理端口包括 `7890`、`7897`、`10809`、`20171`。改完后重新启动 `start-proxy.bat`。

### 某些页面不能翻译

Edge 不允许扩展注入浏览器内部页面，例如 `edge://settings`、扩展商店页面、新标签页等。这是浏览器限制。

### 翻译很慢

扩展按可见区域分批翻译，不会一次性翻译整页。大页面首次翻译会分多批完成；继续滚动时会自动翻译新区域。

### 不想替换原文

在页面右上角翻译条里把模式改成“双语”。

## 安全提醒

不要把 `proxy/.env` 发给别人，也不要把 API key 写进 `extension/` 目录。这个项目的设计就是让扩展只访问本地代理，API key 留在本机。
