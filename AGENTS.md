# myde-unix-socket 开发指南

## 项目概述

node.js原生模块，用于处理unix socket，支持传递fd (SCM_RIGHTS)，支持对方pid识别

使用rust（neon）开发原生部分，nix处理socket，使用ts处理api包装。vitest测试。

支持创建服务器（UServer）并监听地址，有客户端连接时返回USocket连接。或者作为客户端（USocket），连接某个路径。

该js库调用方式见`README.md`

## 开发环境

### 前置要求

- Node.js >= 18
- Rust (最新稳定版)
- pnpm (包管理器)

## 项目结构

```
├── src/                    # 源代码
│   ├── index.ts           # 主入口，导出类型定义
│   ├── lib.rs             # Rust 库入口，几乎没有代码
│   ├── socket.rs          # Unix socket Rust 实现
│   └── socket.test.ts     # Socket 单元测试，只在该项目内部实现中运行，即自己创建服务器和客户端连接测试
├── test/                  # 测试文件
│   ├── bin/               # Rust 测试二进制
│   │   ├── echo_server.rs
│   │   └── echo_client.rs
│   └── echo-cli.test.ts   # 与原生的混合测试
├── dist/
├── Cargo.toml
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## 构建命令

### 完整构建

```bash
pnpm run build
```

### 分步构建

```bash
# 构建 Rust 模块
pnpm run build:rust

# 构建 TypeScript
pnpm run build:ts

```

## 开发流程

### 1. 代码风格

- **TypeScript**: 使用严格模式，遵循现有代码风格，使用biome格式化和lint
- **Rust**: 遵循 rustfmt 默认格式

### 2. 测试要求

- 所有新功能必须包含测试
- 根据需求选择内部测试或者与原生混合测试（需要用rust写原生软件）

### 3. 新增功能

- 必要时更新`README.md`
- 必要时更新此`AGENTS.md`文档
- 如果在开发时发现描述冲突，也更新此文档来修复
