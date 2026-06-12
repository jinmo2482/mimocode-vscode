# MiMoCode VSCode Extension

AI编程助手 - MiMoCode的VSCode扩展

## 功能特性

- **聊天面板**: 在侧边栏中与MiMoCode AI进行对话
- **流式响应**: 实时显示AI回复，打字机效果
- **代码高亮**: Markdown渲染支持代码块语法高亮
- **代码上下文**: 自动包含当前文件和选中的代码
- **@mention文件**: 使用@符号引用工作区中的文件
- **拖拽文件**: 支持拖拽文件到聊天面板
- **Diff查看**: 查看和接受/拒绝AI的代码修改
- **终端集成**: 在VSCode终端中执行AI的命令
- **工具调用**: 显示AI使用的工具和结果
- **会话管理**: 创建、切换、删除会话
- **模型选择**: 快速切换AI模型

## 安装

### 从VSIX安装

1. 下载 `mimocode-vscode-0.1.0.vsix` 文件
2. 在VSCode中，打开命令面板 (Ctrl+Shift+P)
3. 输入 "Extensions: Install from VSIX..."
4. 选择下载的 .vsix 文件

### 从源码构建

```bash
cd mimocode-vscode
npm install
npm run build
npm run package
```

## 配置

在VSCode设置中配置MiMoCode:

| 设置项 | 默认值 | 描述 |
|--------|--------|------|
| `mimocode.server.port` | 7860 | MiMoCode HTTP服务器端口 |
| `mimocode.server.autoStart` | true | 自动启动MiMoCode服务器 |
| `mimocode.server.path` | "mimo" | MiMoCode可执行文件路径 |
| `mimocode.model` | - | 默认模型 |
| `mimocode.mode` | "auto" | 默认模式 (code/chat/auto) |

## 使用方法

### 打开聊天面板

1. 点击活动栏中的MiMoCode图标
2. 或者使用命令 `MiMoCode: Open Chat`

### 发送消息

1. 在输入框中输入问题
2. 按 Enter 或点击 Send 按钮
3. AI会实时流式回复

### 引用文件

在输入框中输入 `@` 符号，然后输入文件名的一部分，会自动显示匹配的文件列表。

### 拖拽文件

将文件从文件资源管理器拖拽到聊天面板，文件内容会自动添加到输入框。

### 查看代码修改

当AI修改代码时，会在聊天面板中显示diff卡片:
- 点击 **View** 查看详细的diff对比
- 点击 **Accept** 接受修改
- 点击 **Reject** 拒绝修改

### 右键菜单

选中代码后，右键点击 "Ask MiMoCode" 可以直接将选中的代码发送给AI。

### 会话管理

- 点击 "+" 按钮创建新会话
- 在会话列表中切换会话
- 使用命令 `MiMoCode: Switch Session` 切换会话

### 模型选择

使用命令 `MiMoCode: Set Model` 选择不同的AI模型。

## 命令列表

| 命令 | 描述 |
|------|------|
| `MiMoCode: Open Chat` | 打开聊天面板 |
| `MiMoCode: Ask MiMoCode` | 发送选中的代码给AI |
| `MiMoCode: New Session` | 创建新的会话 |
| `MiMoCode: Accept Change` | 接受当前的diff |
| `MiMoCode: Reject Change` | 拒绝当前的diff |
| `MiMoCode: Accept All Changes` | 接受所有diff |
| `MiMoCode: Reject All Changes` | 拒绝所有diff |
| `MiMoCode: Abort` | 中断当前操作 |
| `MiMoCode: Set Model` | 选择模型 |
| `MiMoCode: Switch Session` | 切换会话 |
| `MiMoCode: Refresh Sessions` | 刷新会话列表 |

## 快捷键

| 快捷键 | 描述 |
|--------|------|
| `Enter` | 发送消息 |
| `Ctrl+Enter` | 换行 |
| `@` | 引用文件 |

## 开发

```bash
# 安装依赖
npm install

# 构建
npm run build

# 监听模式
npm run watch

# 打包
npm run package
```

## 依赖

- VSCode >= 1.85.0
- Node.js
- MiMoCode CLI

## 许可证

MIT
