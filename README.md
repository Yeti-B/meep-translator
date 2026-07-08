# meep-translator

一个接近 Edge 自带网页翻译体验的浏览器扩展：

- 在扩展设置页填写 API Key、Base URL 和模型后即可使用。
- 支持 OpenAI 官方 API，也支持 OpenAI-compatible 中转服务。
- 点击扩展按钮或右键菜单开始翻译当前网页。
- 阅读时继续向下滚动，新出现的文本会自动翻译。
- 支持“替换原文”和“双语显示”。
- 恢复原文后会保留页面内译文缓存，再切回译文不会重复消耗 token。
- 可选本地代理模式，把 API Key 留在本机 Node 服务里。

## 快速使用

### 1. 在 Edge 加载扩展

1. 打开 Edge，进入 `edge://extensions/`。
2. 打开“开发人员模式”。
3. 点击“加载解压缩的扩展”。
4. 选择本项目里的 `extension` 文件夹。

### 2. 填写 API 配置

在扩展详情页点击“扩展选项”，或翻译条里点击“设置”。

常规 OpenAI 官方配置：

```text
连接方式：直连 API
API Key：你的 sk-... key
Base URL：https://api.openai.com/v1
API 模式：Responses API
模型：从下拉菜单选择 GPT-5.4 mini
```

OpenAI-compatible 中转示例：

```text
连接方式：直连 API
API Key：你的中转 key
Base URL：https://colabapi.com/v1
API 模式：Chat Completions 兼容
模型：先从下拉菜单选择；如果服务商给了特殊模型名，选择“自定义模型名”并在下方输入框填写
```

填完后点击“保存设置”，再点“测试连接”。测试成功后就可以翻译网页。

### 3. 翻译网页

- 打开一个外语网页。
- 点击浏览器工具栏里的扩展图标，开始翻译。
- 也可以在页面空白处右键，选择“用 meep-translator 翻译此页”。
- 页面右上角会出现翻译条：
  - `翻译`：继续扫描并翻译当前可见内容。
  - `暂停`：停止滚动自动翻译。
  - `原文`：恢复已经替换过的原文，译文会保留在页面内缓存。
  - `设置`：打开 API 配置页。

## 翻译建议

翻译场景建议优先选择 `gpt-5.4-mini`，速度更快，也更适合 ChatGPT/Codex 账号的兼容模式。`gpt-5.4-nano` 更轻，但在部分 ChatGPT/Codex 账号环境中不可用；如果你的 API 或中转服务明确支持它，可以用“自定义模型名”手动填写。

扩展里提供这些预设：

```text
速度优先：GPT-5.4 mini
质量优先：GPT-5.4、GPT-5.5
自定义模型名：用于 ColabAPI、one-api、new-api 等中转服务；下拉选择“自定义模型名”后，在下方输入框填写服务商给出的模型名
```

论文翻译推荐：

```text
模型：gpt-5.4-mini
推理强度：low
输出长度：low
```

翻译任务通常不需要很高推理强度。遇到特别绕的理论段落、方法推导或控制算法说明时，可以把推理强度改成 `medium`。

## 本地代理模式

如果不想把 API Key 存在浏览器扩展的本地存储里，可以使用本地代理模式。

复制配置文件：

```powershell
Copy-Item .\proxy\.env.example .\proxy\.env
```

编辑 `proxy/.env`：

```text
OPENAI_API_KEY=sk-your-api-key-here
OPENAI_BASE_URL=https://colabapi.com/v1
OPENAI_API_MODE=chat
OPENAI_MODEL=gpt-5.4-mini
OPENAI_HTTP_PROXY=http://127.0.0.1:7890
```

启动代理：

```powershell
.\start-proxy.bat
```

然后在扩展选项里选择：

```text
连接方式：本地代理
代理地址：http://127.0.0.1:8787
```

## 常见问题

### 测试连接失败

确认：

- API Key 没有多复制空格。
- Base URL 以 `/v1` 结尾，例如 `https://api.openai.com/v1`。
- 中转服务通常选择“Chat Completions 兼容”。
- 模型名必须是当前服务商支持的模型名。
- 如果需要代理访问外网，确认 Clash 等代理工具正在运行。

### 某些页面不能翻译

Edge 不允许扩展注入浏览器内部页面，例如 `edge://settings`、扩展商店页面、新标签页等。这是浏览器限制。

### 翻译很慢

扩展按可见区域分批翻译，不会一次性翻译整页。大页面首次翻译会分多批完成；继续滚动时会自动翻译新区域。

### 不想替换原文

在翻译条或扩展选项里把显示模式改成“双语显示”。

## 安全提醒

直连 API 模式会把 API Key 保存在浏览器扩展的本地存储中，适合个人自用和简单分发。不要把自己的 key 写进代码或提交到 GitHub。

本地代理模式会把 API Key 放在 `proxy/.env`。该文件已被 `.gitignore` 排除，不会被提交。
